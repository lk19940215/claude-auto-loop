'use strict';

const fs = require('fs');
const path = require('path');
const { paths, loadConfig, buildEnvVars, getAllowedTools, log } = require('./config');
const { Indicator, inferPhaseStep } = require('./indicator');
const { buildSystemPrompt, buildCodingPrompt, buildScanPrompt, buildAddPrompt } = require('./prompts');

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
  if (opts.model) base.model = opts.model;
  else if (config.model) base.model = config.model;
  return base;
}

function extractResult(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'result') return messages[i];
  }
  return null;
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function logMessage(message, logStream, indicator) {
  if (message.type === 'assistant' && message.message?.content) {
    for (const block of message.message.content) {
      if (block.type === 'text' && block.text) {
        if (indicator) {
          const statusLine = indicator.getStatusLine();
          process.stderr.write('\r\x1b[K');
          if (statusLine) process.stderr.write(statusLine + '\n');
          if (logStream && statusLine) {
            logStream.write('\n' + stripAnsi(statusLine) + '\n');
          }
        }
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
  const taskId = opts.taskId || 'unknown';
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const logFile = path.join(p.logsDir, `${taskId}_session_${sessionNum}_${dateStr}.log`);
  const activityLogFile = path.join(p.logsDir, `session_${sessionNum}.activity.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  indicator.start(sessionNum, activityLogFile);

  const editCounts = {};
  const EDIT_THRESHOLD = 5;
  const stallTimeoutMs = config.stallTimeout * 1000;
  let stallDetected = false;

  const stallChecker = setInterval(() => {
    const idleMs = Date.now() - indicator.lastToolTime;
    if (idleMs > stallTimeoutMs && !stallDetected) {
      stallDetected = true;
      log('warn', `无新工具调用超过 ${Math.floor(idleMs / 60000)} 分钟，自动中断 session`);
    }
  }, 30000);

  try {
    const queryOpts = buildQueryOptions(config, opts);
    queryOpts.systemPrompt = systemPrompt;
    queryOpts.hooks = {
      PreToolUse: [{
        matcher: '*',
        hooks: [async (input) => {
          inferPhaseStep(indicator, input.tool_name, input.tool_input);

          const target = input.tool_input?.file_path || input.tool_input?.path || '';
          const toolSummary = target ? target.split('/').slice(-2).join('/') : '';
          if (toolSummary) {
            logStream.write(`[${new Date().toISOString()}] ${input.tool_name}: ${toolSummary}\n`);
          }

          if (['Write', 'Edit', 'MultiEdit'].includes(input.tool_name) && target) {
            editCounts[target] = (editCounts[target] || 0) + 1;
            if (editCounts[target] > EDIT_THRESHOLD) {
              return {
                decision: 'block',
                message: `已对 ${target} 编辑 ${editCounts[target]} 次，疑似死循环。请重新审视方案后再继续。`,
              };
            }
          }

          return {};
        }]
      }]
    };

    const session = sdk.query({ prompt, options: queryOpts });

    const collected = [];
    for await (const message of session) {
      if (stallDetected) {
        log('warn', '停顿超时，中断消息循环');
        break;
      }
      collected.push(message);
      logMessage(message, logStream, indicator);
    }

    clearInterval(stallChecker);
    logStream.end();
    indicator.stop();

    const result = extractResult(collected);
    return {
      exitCode: stallDetected ? 2 : 0,
      cost: result?.total_cost_usd ?? null,
      tokenUsage: result?.usage ?? null,
      logFile,
      stalled: stallDetected,
    };
  } catch (err) {
    clearInterval(stallChecker);
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
  const logFile = path.join(p.logsDir, `scan_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.log`);
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
      logMessage(message, logStream, indicator);
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

async function runAddSession(instruction, opts = {}) {
  const sdk = await loadSDK();
  const config = loadConfig();
  applyEnvConfig(config);
  const indicator = new Indicator();

  const systemPrompt = buildSystemPrompt(false);
  const prompt = buildAddPrompt(instruction);

  const p = paths();
  const logFile = path.join(p.logsDir, `add_tasks_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  indicator.start(0);
  log('info', '正在追加任务...');

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

    for await (const message of session) {
      logMessage(message, logStream, indicator);
    }

    logStream.end();
    indicator.stop();
    log('ok', '任务追加完成');
  } catch (err) {
    logStream.end();
    indicator.stop();
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
  runAddSession,
  hasCodeFiles,
};
