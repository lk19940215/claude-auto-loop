'use strict';

const fs = require('fs');
const { execSync } = require('child_process');
const { paths, log, getProjectRoot } = require('./config');
const { loadTasks, getFeatures } = require('./tasks');

function tryExtractFromBroken(text) {
  const result = {};
  const srMatch = text.match(/"session_result"\s*:\s*"(success|failed)"/);
  if (srMatch) result.session_result = srMatch[1];
  const saMatch = text.match(/"status_after"\s*:\s*"(\w+)"/);
  if (saMatch) result.status_after = saMatch[1];
  const sbMatch = text.match(/"status_before"\s*:\s*"(\w+)"/);
  if (sbMatch) result.status_before = sbMatch[1];
  return Object.keys(result).length > 0 ? result : null;
}

function inferFromTasks(taskId) {
  if (!taskId) return null;
  const data = loadTasks();
  if (!data) return null;
  const task = getFeatures(data).find(f => f.id === taskId);
  return task ? task.status : null;
}

function validateSessionResult() {
  const p = paths();

  if (!fs.existsSync(p.sessionResult)) {
    log('error', 'Agent 未生成 session_result.json');
    return { valid: false, fatal: true, recoverable: false, reason: 'session_result.json 不存在' };
  }

  const raw = fs.readFileSync(p.sessionResult, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    log('warn', `session_result.json 解析失败: ${err.message}`);
    const extracted = tryExtractFromBroken(raw);
    if (extracted) {
      log('info', `从截断 JSON 中提取到关键字段: ${JSON.stringify(extracted)}`);
      return { valid: false, fatal: false, recoverable: true, reason: 'JSON 截断但提取到关键字段', data: extracted };
    }
    return { valid: false, fatal: false, recoverable: true, reason: `JSON 解析失败: ${err.message}` };
  }

  // Backward compat: unwrap legacy { current: {...} } format
  if (data.current && typeof data.current === 'object') {
    data = data.current;
  }

  const required = ['session_result', 'status_after'];
  const missing = required.filter(k => !(k in data));
  if (missing.length > 0) {
    log('warn', `session_result.json 缺少字段: ${missing.join(', ')}`);
    return { valid: false, fatal: false, recoverable: true, reason: `缺少字段: ${missing.join(', ')}` };
  }

  if (!['success', 'failed'].includes(data.session_result)) {
    log('warn', `session_result 必须是 success 或 failed，实际是: ${data.session_result}`);
    return { valid: false, fatal: false, recoverable: true, reason: `无效 session_result: ${data.session_result}`, data };
  }

  const validStatuses = ['pending', 'in_progress', 'testing', 'done', 'failed'];
  if (!validStatuses.includes(data.status_after)) {
    log('warn', `status_after 不合法: ${data.status_after}`);
    return { valid: false, fatal: false, recoverable: true, reason: `无效 status_after: ${data.status_after}`, data };
  }

  if (data.session_result === 'success') {
    log('ok', 'session_result.json 合法 (success)');
  } else {
    log('warn', 'session_result.json 合法，但 Agent 报告失败 (failed)');
  }

  return { valid: true, fatal: false, recoverable: false, data };
}

function checkGitProgress(headBefore) {
  if (!headBefore) {
    log('info', '未提供 head_before，跳过 git 检查');
    return { hasCommit: false, warning: false };
  }

  const projectRoot = getProjectRoot();
  let headAfter;
  try {
    headAfter = execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf8' }).trim();
  } catch {
    headAfter = 'none';
  }

  if (headBefore === headAfter) {
    log('warn', '本次会话没有新的 git 提交');
    return { hasCommit: false, warning: true };
  }

  try {
    const msg = execSync('git log --oneline -1', { cwd: projectRoot, encoding: 'utf8' }).trim();
    log('ok', `检测到新提交: ${msg}`);
  } catch { /* ignore */ }

  return { hasCommit: true, warning: false };
}

function checkTestCoverage(taskId, statusAfter) {
  const p = paths();

  if (!fs.existsSync(p.testsFile)) return;
  if (statusAfter !== 'done' || !taskId) return;

  try {
    const tests = JSON.parse(fs.readFileSync(p.testsFile, 'utf8'));
    const testCases = tests.test_cases || [];
    const taskTests = testCases.filter(t => t.feature_id === taskId);
    if (taskTests.length > 0) {
      const failed = taskTests.filter(t => t.last_result === 'fail');
      if (failed.length > 0) {
        log('warn', `tests.json 中有失败的验证记录: ${failed.map(t => t.id).join(', ')}`);
      } else {
        log('ok', `${taskTests.length} 条验证记录覆盖任务 ${taskId}`);
      }
    }
  } catch { /* ignore */ }
}

async function validate(headBefore, taskId) {
  log('info', '========== 开始校验 ==========');

  const srResult = validateSessionResult();
  const gitResult = checkGitProgress(headBefore);

  let fatal = false;
  let hasWarnings = false;

  if (srResult.valid) {
    hasWarnings = gitResult.warning;
  } else {
    // session_result.json has issues — cross-validate with git + tasks.json
    if (gitResult.hasCommit) {
      const taskStatus = inferFromTasks(taskId);
      if (taskStatus === 'done' || taskStatus === 'testing') {
        log('warn', `session_result.json 异常，但 tasks.json 显示 ${taskId} 已 ${taskStatus}，且有新提交，降级为警告`);
      } else {
        log('warn', 'session_result.json 异常，但有新提交，降级为警告（不回滚代码）');
      }
      hasWarnings = true;
    } else {
      log('error', '无新提交且 session_result.json 异常，视为致命');
      fatal = true;
    }
  }

  const statusAfter = srResult.data?.status_after || inferFromTasks(taskId) || null;
  checkTestCoverage(taskId, statusAfter);

  if (fatal) {
    log('error', '========== 校验失败 (致命) ==========');
  } else if (hasWarnings) {
    log('warn', '========== 校验通过 (有警告) ==========');
  } else {
    log('ok', '========== 校验全部通过 ==========');
  }

  return { fatal, hasWarnings, sessionData: srResult.data };
}

module.exports = { validate, validateSessionResult, checkGitProgress };
