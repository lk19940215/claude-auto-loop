'use strict';

const fs = require('fs');
const path = require('path');
const { paths, loadConfig, buildEnvVars, getAllowedTools, log } = require('./config');
const { Indicator, inferPhaseStep } = require('./indicator');
const { buildSystemPrompt, buildCodingPrompt, buildScanPrompt, buildViewPrompt, buildAddPrompt } = require('./prompts');

let _sdkModule = null;
async function loadSDK() {
  if (_sdkModule) return _sdkModule;

  const pkgName = '@anthropic-ai/claude-agent-sdk';
  const attempts = [
    () => import(pkgName),
    () => {
      const { createRequire } = require('module');
      const resolved = createRequire(__filename).resolve(pkgName);
      return import(resolved);
    },
    () => {
      const { execSync } = require('child_process');
      const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
      const sdkPath = path.join(prefix, 'lib', 'node_modules', pkgName, 'sdk.mjs');
      return import(sdkPath);
    },
  ];

  for (const attempt of attempts) {
    try {
      _sdkModule = await attempt();
      return _sdkModule;
    } catch { /* try next */ }
  }

  log('error', `未找到 ${pkgName}`);
  log('error', `请先安装：npm install -g ${pkgName}`);
  process.exit(1);
}

function applyEnvConfig(config) {
  Object.assign(process.env, buildEnvVars(config));
}

function buildQueryOptions(config, opts = {}) {
  const base = {
    allowedTools: getAllowedTools(config),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    cwd: opts.projectRoot || process.cwd(),
    env: buildEnvVars(config),
    settingSources: ['project'],
  };
  if (config.model) base.model = config.model;
  return base;
}

function extractResult(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'result') return messages[i];
  }
  return null;
}

function logMessage(message, logStream) {
  if (message.type === 'assistant' && message.message?.content) {
    for (const block of message.message.content) {
      if (block.type === 'text' && block.text) {
        process.stdout.write(block.text);
        if (logStream) logStream.write(block.text);
      }
    }
  }
}

async function runCodingSession(sessionNum, opts = {}) {
  const sdk = await loadSDK();
  const config = loadConfig();
  applyEnvConfig(config);
  const indicator = new Indicator();

  const prompt = buildCodingPrompt(sessionNum, opts);
  const systemPrompt = buildSystemPrompt(false);

  const p = paths();
  const logFile = path.join(p.logsDir, `session_${sessionNum}_${Date.now()}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  indicator.start(sessionNum);

  try {
    const queryOpts = buildQueryOptions(config, opts);
    queryOpts.systemPrompt = systemPrompt;
    queryOpts.hooks = {
      PreToolUse: [{
        matcher: '*',
        hooks: [async (input) => {
          inferPhaseStep(indicator, input.tool_name, input.tool_input);
          return {};
        }]
      }]
    };

    const session = sdk.query({ prompt, options: queryOpts });

    const collected = [];
    for await (const message of session) {
      collected.push(message);
      logMessage(message, logStream);
    }

    logStream.end();
    indicator.stop();

    const result = extractResult(collected);
    return {
      exitCode: 0,
      cost: result?.total_cost_usd ?? null,
      tokenUsage: result?.usage ?? null,
      logFile,
    };
  } catch (err) {
    logStream.end();
    indicator.stop();
    log('error', `Claude SDK 错误: ${err.message}`);
    return {
      exitCode: 1,
      cost: null,
      tokenUsage: null,
      logFile,
      error: err.message,
    };
  }
}

async function runScanSession(requirement, opts = {}) {
  const sdk = await loadSDK();
  const config = loadConfig();
  applyEnvConfig(config);
  const indicator = new Indicator();

  const projectType = hasCodeFiles(opts.projectRoot || process.cwd()) ? 'existing' : 'new';
  const prompt = buildScanPrompt(projectType, requirement);
  const systemPrompt = buildSystemPrompt(true);

  const p = paths();
  const logFile = path.join(p.logsDir, `scan_${Date.now()}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  indicator.start(0);
  log('info', `正在调用 Claude Code 执行项目扫描（${projectType}项目）...`);

  try {
    const queryOpts = buildQueryOptions(config, opts);
    queryOpts.systemPrompt = systemPrompt;
    queryOpts.hooks = {
      PreToolUse: [{
        matcher: '*',
        hooks: [async (input) => {
          inferPhaseStep(indicator, input.tool_name, input.tool_input);
          return {};
        }]
      }]
    };

    const session = sdk.query({ prompt, options: queryOpts });

    const collected = [];
    for await (const message of session) {
      collected.push(message);
      logMessage(message, logStream);
    }

    logStream.end();
    indicator.stop();

    const result = extractResult(collected);
    return {
      exitCode: 0,
      cost: result?.total_cost_usd ?? null,
      logFile,
    };
  } catch (err) {
    logStream.end();
    indicator.stop();
    log('error', `扫描失败: ${err.message}`);
    return { exitCode: 1, cost: null, logFile, error: err.message };
  }
}

async function runViewSession(requirement, opts = {}) {
  const sdk = await loadSDK();
  const p = paths();
  const config = loadConfig();
  applyEnvConfig(config);

  let systemPrompt;
  let prompt;

  if (!fs.existsSync(p.profile) || !fs.existsSync(p.tasksFile)) {
    systemPrompt = buildSystemPrompt(true);
    const projectType = hasCodeFiles(opts.projectRoot || process.cwd()) ? 'existing' : 'new';
    prompt = buildViewPrompt({ needsScan: true, projectType, requirement });
  } else {
    systemPrompt = buildSystemPrompt(false);
    const { loadTasks, getFeatures } = require('./tasks');
    const data = loadTasks();
    const features = getFeatures(data);
    const allDone = features.length > 0 && features.every(f => f.status === 'done');
    prompt = buildViewPrompt({ allDone });
  }

  try {
    const queryOpts = buildQueryOptions(config, opts);
    queryOpts.systemPrompt = systemPrompt;

    const session = sdk.query({ prompt, options: queryOpts });

    for await (const message of session) {
      logMessage(message, null);
    }
  } catch (err) {
    log('error', `观测模式错误: ${err.message}`);
  }
}

async function runAddSession(instruction, opts = {}) {
  const sdk = await loadSDK();
  const config = loadConfig();
  applyEnvConfig(config);

  const systemPrompt = buildSystemPrompt(false);
  const prompt = buildAddPrompt(instruction);

  const p = paths();
  const logFile = path.join(p.logsDir, `add_tasks_${Date.now()}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  try {
    const queryOpts = buildQueryOptions(config, opts);
    queryOpts.systemPrompt = systemPrompt;

    const session = sdk.query({ prompt, options: queryOpts });

    for await (const message of session) {
      logMessage(message, logStream);
    }

    logStream.end();
    log('ok', '任务追加完成');
  } catch (err) {
    logStream.end();
    log('error', `任务追加失败: ${err.message}`);
  }
}

function hasCodeFiles(projectRoot) {
  const markers = [
    'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py',
    'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle',
    'Makefile', 'Dockerfile', 'docker-compose.yml',
    'README.md', 'main.py', 'app.py', 'index.js', 'index.ts',
  ];
  for (const m of markers) {
    if (fs.existsSync(path.join(projectRoot, m))) return true;
  }
  for (const d of ['src', 'lib', 'app', 'backend', 'frontend', 'web', 'server', 'client']) {
    if (fs.existsSync(path.join(projectRoot, d)) && fs.statSync(path.join(projectRoot, d)).isDirectory()) return true;
  }
  return false;
}

module.exports = {
  runCodingSession,
  runScanSession,
  runViewSession,
  runAddSession,
  hasCodeFiles,
};
