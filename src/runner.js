'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const { paths, log, COLOR, loadConfig, ensureLoopDir, getProjectRoot, getRequirementsHash } = require('./config');
const { loadTasks, saveTasks, getFeatures, getStats, findNextTask } = require('./tasks');
const { validate } = require('./validator');
const { scan } = require('./scanner');
const { runCodingSession, runViewSession, runAddSession } = require('./session');

const MAX_RETRY = 3;

async function requireSdk() {
  const pkgName = '@anthropic-ai/claude-agent-sdk';
  const attempts = [
    () => { require.resolve(pkgName); return true; },
    () => {
      const { createRequire } = require('module');
      createRequire(__filename).resolve(pkgName);
      return true;
    },
    () => {
      const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
      const sdkPath = path.join(prefix, 'lib', 'node_modules', pkgName);
      if (fs.existsSync(sdkPath)) return true;
      throw new Error('not found');
    },
  ];
  for (const attempt of attempts) {
    try { if (attempt()) return; } catch { /* try next */ }
  }
  console.error(`错误：未找到 ${pkgName}`);
  console.error(`请先安装：npm install -g ${pkgName}`);
  process.exit(1);
}

function getHead() {
  try {
    return execSync('git rev-parse HEAD', { cwd: getProjectRoot(), encoding: 'utf8' }).trim();
  } catch {
    return 'none';
  }
}

function allTasksDone() {
  const data = loadTasks();
  if (!data) return false;
  const features = getFeatures(data);
  if (features.length === 0) return true;
  return features.every(f => f.status === 'done');
}

function rollback(headBefore, reason) {
  if (!headBefore || headBefore === 'none') return;
  log('warn', `回滚到 ${headBefore} ...`);
  try {
    execSync(`git reset --hard ${headBefore}`, { cwd: getProjectRoot(), stdio: 'inherit' });
    log('ok', '回滚完成');
  } catch (err) {
    log('error', `回滚失败: ${err.message}`);
  }

  // Record failure in progress.json
  appendProgress({
    type: 'rollback',
    timestamp: new Date().toISOString(),
    reason: reason || 'harness 校验失败',
    rollbackTo: headBefore,
  });
}

function markTaskFailed() {
  const data = loadTasks();
  if (!data) return;
  const features = getFeatures(data);
  for (const f of features) {
    if (f.status === 'in_progress') {
      f.status = 'failed';
      break;
    }
  }
  saveTasks(data);
}

function tryPush() {
  try {
    const remotes = execSync('git remote', { cwd: getProjectRoot(), encoding: 'utf8' }).trim();
    if (!remotes) return;
    log('info', '正在推送代码...');
    execSync('git push', { cwd: getProjectRoot(), stdio: 'inherit' });
    log('ok', '推送成功');
  } catch {
    log('warn', '推送失败 (请检查网络或权限)，继续执行...');
  }
}

function appendProgress(entry) {
  const p = paths();
  let progress = { sessions: [] };
  if (fs.existsSync(p.progressFile)) {
    try { progress = JSON.parse(fs.readFileSync(p.progressFile, 'utf8')); } catch { /* reset */ }
  }
  if (!Array.isArray(progress.sessions)) progress.sessions = [];
  progress.sessions.push(entry);
  fs.writeFileSync(p.progressFile, JSON.stringify(progress, null, 2) + '\n', 'utf8');
}

function updateSessionHistory(sessionData, sessionNum) {
  const p = paths();
  let sr = { current: null, history: [] };
  if (fs.existsSync(p.sessionResult)) {
    try { sr = JSON.parse(fs.readFileSync(p.sessionResult, 'utf8')); } catch { /* reset */ }
    if (!sr.history && sr.session_result) {
      sr = { current: sr, history: [] };
    }
  }

  // Move current to history
  if (sr.current) {
    sr.history.push({
      session: sessionNum - 1,
      timestamp: new Date().toISOString(),
      ...sr.current,
    });
    sr.current = null;
  }

  if (sessionData) {
    sr.current = sessionData;
  }

  fs.writeFileSync(p.sessionResult, JSON.stringify(sr, null, 2) + '\n', 'utf8');
}

function printStats() {
  const data = loadTasks();
  if (!data) return;
  const stats = getStats(data);
  log('info', `进度: ${stats.done}/${stats.total} done, ${stats.in_progress} in_progress, ${stats.testing} testing, ${stats.failed} failed, ${stats.pending} pending`);
}

async function promptContinue() {
  if (!process.stdin.isTTY) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('是否继续？(y/n) ', answer => {
      rl.close();
      resolve(/^[Yy]/.test(answer.trim()));
    });
  });
}

async function run(requirement, opts = {}) {
  const p = paths();
  const projectRoot = getProjectRoot();
  ensureLoopDir();

  const maxSessions = opts.max || 50;
  const pauseEvery = opts.pause || 5;
  const dryRun = opts.dryRun || false;

  console.log('');
  console.log('============================================');
  console.log(`  Claude Coder${dryRun ? ' (预览模式)' : ''}`);
  console.log('============================================');
  console.log('');

  // Load config
  const config = loadConfig();
  if (config.provider !== 'claude' && config.baseUrl) {
    log('ok', `模型配置已加载: ${config.provider}${config.model ? ` (${config.model})` : ''}`);
  }

  // Read requirement from requirements.md or CLI
  const reqFile = path.join(projectRoot, 'requirements.md');
  if (fs.existsSync(reqFile) && !requirement) {
    requirement = fs.readFileSync(reqFile, 'utf8');
    log('ok', '已读取需求文件: requirements.md');
  }

  // Ensure git repo
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: projectRoot, stdio: 'ignore' });
  } catch {
    log('info', '初始化 git 仓库...');
    execSync('git init', { cwd: projectRoot, stdio: 'inherit' });
    execSync('git add -A && git commit -m "init: 项目初始化" --allow-empty', {
      cwd: projectRoot,
      stdio: 'inherit',
    });
  }

  // Initialization (scan) if needed
  if (!fs.existsSync(p.profile) || !fs.existsSync(p.tasksFile)) {
    if (!requirement) {
      log('error', '首次运行需要提供需求描述');
      console.log('');
      console.log('用法（二选一）:');
      console.log('  方式 1: 在项目根目录创建 requirements.md');
      console.log('          claude-coder run');
      console.log('');
      console.log('  方式 2: 直接传入一句话需求');
      console.log('          claude-coder run "你的需求描述"');
      process.exit(1);
    }

    if (dryRun) {
      log('info', '[DRY-RUN] 将执行初始化扫描（跳过）');
      const reqPreview = (requirement || '').slice(0, 100);
      log('info', `[DRY-RUN] 需求: ${reqPreview}${reqPreview.length >= 100 ? '...' : ''}`);
      return;
    }

    await requireSdk();
    const scanResult = await scan(requirement, { projectRoot });
    if (!scanResult.success) {
      console.log('');
      console.log(`${COLOR.yellow}═══════════════════════════════════════════════${COLOR.reset}`);
      console.log(`${COLOR.yellow}  若出现 "Credit balance is too low"，请运行:${COLOR.reset}`);
      console.log(`  ${COLOR.green}claude-coder setup${COLOR.reset}`);
      console.log(`${COLOR.yellow}═══════════════════════════════════════════════${COLOR.reset}`);
      process.exit(1);
    }
  } else {
    log('ok', '检测到已有 project_profile.json + tasks.json，跳过初始化');
    printStats();
  }

  // Coding loop
  if (!dryRun) await requireSdk();
  log('info', `开始编码循环 (最多 ${maxSessions} 个会话) ...`);
  console.log('');

  let consecutiveFailures = 0;

  for (let session = 1; session <= maxSessions; session++) {
    console.log('');
    console.log('--------------------------------------------');
    log('info', `Session ${session} / ${maxSessions}`);
    console.log('--------------------------------------------');

    if (allTasksDone()) {
      console.log('');
      log('ok', '所有任务已完成！');
      printStats();
      break;
    }

    printStats();

    if (dryRun) {
      const next = findNextTask(loadTasks());
      log('info', `[DRY-RUN] 下一个任务: ${next ? `${next.id} - ${next.description}` : '无'}`);
      if (!next) break;
      continue;
    }

    const headBefore = getHead();

    // Run coding session
    const sessionResult = await runCodingSession(session, {
      projectRoot,
      consecutiveFailures,
      lastValidateLog: consecutiveFailures > 0 ? '上次校验失败' : '',
    });

    // Validate
    log('info', '开始 harness 校验 ...');
    const validateResult = await validate(headBefore);

    if (!validateResult.fatal) {
      log('ok', `Session ${session} 校验通过`);
      tryPush();
      consecutiveFailures = 0;

      // Update session history
      updateSessionHistory(validateResult.sessionData, session);

      // Update sync_state.json if requirements exist
      const reqHash = getRequirementsHash();
      if (reqHash) {
        fs.writeFileSync(p.syncState, JSON.stringify({
          last_requirements_hash: reqHash,
          last_synced_at: new Date().toISOString(),
        }, null, 2) + '\n', 'utf8');
      }

      // Append to progress.json
      appendProgress({
        session,
        timestamp: new Date().toISOString(),
        result: 'success',
        cost: sessionResult.cost,
        taskId: validateResult.sessionData?.task_id || null,
        statusAfter: validateResult.sessionData?.status_after || null,
      });

    } else {
      consecutiveFailures++;
      log('error', `Session ${session} 校验失败 (连续失败: ${consecutiveFailures}/${MAX_RETRY})`);

      rollback(headBefore, '校验失败');

      if (consecutiveFailures >= MAX_RETRY) {
        log('error', `连续失败 ${MAX_RETRY} 次，跳过当前任务`);
        markTaskFailed();
        consecutiveFailures = 0;
        log('warn', '已将任务标记为 failed，继续下一个任务');
      }
    }

    // Periodic pause
    if (session % pauseEvery === 0) {
      console.log('');
      printStats();
      const shouldContinue = await promptContinue();
      if (!shouldContinue) {
        log('info', '手动停止');
        break;
      }
    }
  }

  // Final report
  console.log('');
  console.log('============================================');
  console.log('  运行结束');
  console.log('============================================');
  console.log('');
  printStats();
}

async function view(requirement, opts = {}) {
  await requireSdk();
  const projectRoot = getProjectRoot();
  ensureLoopDir();

  log('info', '观测模式：交互式运行，实时显示工具调用和决策过程');
  log('info', '退出：Ctrl+C');
  console.log('--------------------------------------------');

  await runViewSession(requirement, { projectRoot, ...opts });
}

async function add(instruction, opts = {}) {
  await requireSdk();
  const p = paths();
  const projectRoot = getProjectRoot();
  ensureLoopDir();

  if (!fs.existsSync(p.profile) || !fs.existsSync(p.tasksFile)) {
    log('error', 'add 需要先完成初始化（至少运行一次 claude-coder run）');
    process.exit(1);
  }

  await runAddSession(instruction, { projectRoot, ...opts });
  printStats();
}

module.exports = { run, view, add };
