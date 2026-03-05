'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const COLOR = {
  red: '\x1b[0;31m',
  green: '\x1b[0;32m',
  yellow: '\x1b[1;33m',
  blue: '\x1b[0;34m',
  reset: '\x1b[0m',
};

function log(level, msg) {
  const tags = {
    info:  `${COLOR.blue}[INFO]${COLOR.reset} `,
    ok:    `${COLOR.green}[OK]${COLOR.reset}   `,
    warn:  `${COLOR.yellow}[WARN]${COLOR.reset} `,
    error: `${COLOR.red}[ERROR]${COLOR.reset}`,
  };
  console.error(`${tags[level] || ''} ${msg}`);
}

function getProjectRoot() {
  return process.cwd();
}

function getLoopDir() {
  return path.join(getProjectRoot(), '.claude-coder');
}

function ensureLoopDir() {
  const dir = getLoopDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const runtime = path.join(dir, '.runtime');
  if (!fs.existsSync(runtime)) fs.mkdirSync(runtime, { recursive: true });
  const logs = path.join(runtime, 'logs');
  if (!fs.existsSync(logs)) fs.mkdirSync(logs, { recursive: true });
  return dir;
}

function getTemplatePath(name) {
  return path.join(__dirname, '..', 'templates', name);
}

function paths() {
  const loopDir = getLoopDir();
  const runtime = path.join(loopDir, '.runtime');
  return {
    loopDir,
    envFile:          path.join(loopDir, '.env'),
    tasksFile:        path.join(loopDir, 'tasks.json'),
    progressFile:     path.join(loopDir, 'progress.json'),
    sessionResult:    path.join(loopDir, 'session_result.json'),
    profile:          path.join(loopDir, 'project_profile.json'),
    testsFile:        path.join(loopDir, 'tests.json'),
    testEnvFile:      path.join(loopDir, 'test.env'),
    playwrightAuth:   path.join(loopDir, 'playwright-auth.json'),
    mcpConfig:        path.join(getProjectRoot(), '.mcp.json'),
    claudeMd:         getTemplatePath('CLAUDE.md'),
    scanProtocol:     getTemplatePath('SCAN_PROTOCOL.md'),
    runtime,
    phaseFile:        path.join(runtime, 'phase'),
    stepFile:         path.join(runtime, 'step'),
    logsDir:          path.join(runtime, 'logs'),
  };
}

// --------------- .env parsing ---------------

function parseEnvFile(filepath) {
  if (!fs.existsSync(filepath)) return {};
  const content = fs.readFileSync(filepath, 'utf8');
  const vars = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      vars[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return vars;
}

// --------------- Model mapping ---------------

function loadConfig() {
  const p = paths();
  const env = parseEnvFile(p.envFile);
  const config = {
    provider: env.MODEL_PROVIDER || 'claude',
    baseUrl: env.ANTHROPIC_BASE_URL || '',
    apiKey: env.ANTHROPIC_API_KEY || '',
    authToken: env.ANTHROPIC_AUTH_TOKEN || '',
    model: env.ANTHROPIC_MODEL || '',
    timeoutMs: parseInt(env.API_TIMEOUT_MS, 10) || 3000000,
    mcpToolTimeout: parseInt(env.MCP_TOOL_TIMEOUT, 10) || 30000,
    mcpPlaywright: env.MCP_PLAYWRIGHT === 'true',
    debug: env.CLAUDE_DEBUG || '',
    disableNonessential: env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || '',
    effortLevel: env.CLAUDE_CODE_EFFORT_LEVEL || '',
    smallFastModel: env.ANTHROPIC_SMALL_FAST_MODEL || '',
    defaultOpus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || '',
    defaultSonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
    defaultHaiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
    thinkingBudget: env.ANTHROPIC_THINKING_BUDGET || '',
    stallTimeout: parseInt(env.SESSION_STALL_TIMEOUT, 10) || 1800,
    raw: env,
  };

  // GLM: default model if not set
  if (config.baseUrl && (config.baseUrl.includes('bigmodel.cn') || config.baseUrl.includes('z.ai'))) {
    if (!config.model) config.model = 'glm-4.7';
  }

  // DeepSeek chat → haiku shim (prevent reasoner billing)
  if (config.baseUrl.includes('deepseek') && config.model === 'deepseek-chat') {
    config.model = 'claude-3-haiku-20240307';
    config.defaultOpus = 'claude-3-haiku-20240307';
    config.defaultSonnet = 'claude-3-haiku-20240307';
    config.defaultHaiku = 'claude-3-haiku-20240307';
    config.smallFastModel = 'claude-3-haiku-20240307';
    config.thinkingBudget = '0';
  }

  return config;
}

function buildEnvVars(config) {
  const env = { ...process.env };
  if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl;
  if (config.apiKey) env.ANTHROPIC_API_KEY = config.apiKey;
  if (config.authToken) env.ANTHROPIC_AUTH_TOKEN = config.authToken;
  if (config.model) env.ANTHROPIC_MODEL = config.model;
  if (config.timeoutMs) env.API_TIMEOUT_MS = String(config.timeoutMs);
  if (config.mcpToolTimeout) env.MCP_TOOL_TIMEOUT = String(config.mcpToolTimeout);
  if (config.smallFastModel) env.ANTHROPIC_SMALL_FAST_MODEL = config.smallFastModel;
  if (config.disableNonessential) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = config.disableNonessential;
  if (config.effortLevel) env.CLAUDE_CODE_EFFORT_LEVEL = config.effortLevel;
  if (config.defaultOpus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = config.defaultOpus;
  if (config.defaultSonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = config.defaultSonnet;
  if (config.defaultHaiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = config.defaultHaiku;
  if (config.thinkingBudget) env.ANTHROPIC_THINKING_BUDGET = config.thinkingBudget;
  return env;
}

// --------------- Allowed tools ---------------

function getAllowedTools(config) {
  const tools = [
    'Read', 'Edit', 'MultiEdit', 'Write',
    'Bash', 'Glob', 'Grep', 'LS',
    'Task',
    'WebSearch', 'WebFetch',
  ];
  if (config.mcpPlaywright) tools.push('mcp__playwright__*');
  return tools;
}

// --------------- Sync to global claude settings ---------------

function syncToGlobal() {
  const config = loadConfig();
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const settingsDir = path.dirname(settingsPath);

  if (!fs.existsSync(settingsDir)) fs.mkdirSync(settingsDir, { recursive: true });

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* ignore */ }
  }

  for (const key of ['apiKey', 'anthropicBaseUrl', 'defaultSonnetModel', 'defaultOpusModel', 'defaultHaikuModel', 'model']) {
    delete settings[key];
  }

  if (!settings.env || typeof settings.env !== 'object') settings.env = {};

  const envVars = buildEnvVars(config);
  for (const [key, value] of Object.entries(envVars)) {
    if (key.startsWith('ANTHROPIC_') || key.endsWith('_TIMEOUT_MS') || key === 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC') {
      settings.env[key] = value;
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  log('ok', `已同步配置到 ${settingsPath}`);
}

module.exports = {
  COLOR,
  log,
  getProjectRoot,
  getLoopDir,
  ensureLoopDir,
  getTemplatePath,
  paths,
  parseEnvFile,
  loadConfig,
  buildEnvVars,
  getAllowedTools,
  syncToGlobal,
};
