'use strict';

const fs = require('fs');
const { execSync } = require('child_process');
const { paths, log, getProjectRoot } = require('./config');

function normalizeJson(text) {
  return text.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function validateSessionResult() {
  const p = paths();

  if (!fs.existsSync(p.sessionResult)) {
    log('error', 'Agent 未生成 session_result.json');
    return { valid: false, fatal: true, reason: 'session_result.json 不存在' };
  }

  let data;
  try {
    data = JSON.parse(normalizeJson(fs.readFileSync(p.sessionResult, 'utf8')));
  } catch {
    log('error', 'session_result.json JSON 格式错误');
    return { valid: false, fatal: true, reason: 'JSON 格式错误' };
  }

  const sr = data.current || data;

  const required = ['session_result', 'status_after'];
  const missing = required.filter(k => !(k in sr));
  if (missing.length > 0) {
    log('error', `session_result.json 缺少字段: ${missing.join(', ')}`);
    return { valid: false, fatal: true, reason: `缺少字段: ${missing.join(', ')}` };
  }

  if (!['success', 'failed'].includes(sr.session_result)) {
    log('error', `session_result 必须是 success 或 failed，实际是: ${sr.session_result}`);
    return { valid: false, fatal: true, reason: `无效 session_result: ${sr.session_result}` };
  }

  const validStatuses = ['pending', 'in_progress', 'testing', 'done', 'failed'];
  if (!validStatuses.includes(sr.status_after)) {
    log('error', `status_after 不合法: ${sr.status_after}`);
    return { valid: false, fatal: true, reason: `无效 status_after: ${sr.status_after}` };
  }

  if (!sr.task_id) {
    log('warn', 'session_result.json 缺少 task_id (建议包含)');
  }

  if (sr.session_result === 'success') {
    log('ok', 'session_result.json 合法 (success)');
  } else {
    log('warn', 'session_result.json 合法，但 Agent 报告失败 (failed)');
  }

  return { valid: true, fatal: false, data: sr };
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

function checkTestCoverage() {
  const p = paths();

  if (!fs.existsSync(p.testsFile) || !fs.existsSync(p.sessionResult)) return;

  try {
    const sr = JSON.parse(normalizeJson(fs.readFileSync(p.sessionResult, 'utf8')));
    const current = sr.current || sr;
    const tests = JSON.parse(normalizeJson(fs.readFileSync(p.testsFile, 'utf8')));

    const taskId = current.task_id || '';
    const testCases = tests.test_cases || [];

    if (current.status_after === 'done' && current.tests_passed) {
      const taskTests = testCases.filter(t => t.feature_id === taskId);
      if (taskTests.length > 0) {
        const failed = taskTests.filter(t => t.last_result === 'fail');
        if (failed.length > 0) {
          log('warn', `tests.json 中有失败的验证记录: ${failed.map(t => t.id).join(', ')}`);
        } else {
          log('ok', `${taskTests.length} 条验证记录覆盖任务 ${taskId}`);
        }
      }
    }
  } catch { /* ignore */ }
}

async function validate(headBefore) {
  log('info', '========== 开始校验 ==========');

  const srResult = validateSessionResult();
  const gitResult = checkGitProgress(headBefore);
  checkTestCoverage();

  const fatal = srResult.fatal;
  const hasWarnings = gitResult.warning;

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
