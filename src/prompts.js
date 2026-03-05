'use strict';

const fs = require('fs');
const { paths, loadConfig, getProjectRoot } = require('./config');
const { loadTasks, findNextTask, getStats } = require('./tasks');

/**
 * Build system prompt by combining template files.
 * @param {boolean} includeScanProtocol - Whether to append SCAN_PROTOCOL.md
 */
function buildSystemPrompt(includeScanProtocol = false) {
  const p = paths();
  let prompt = fs.readFileSync(p.claudeMd, 'utf8');
  if (includeScanProtocol && fs.existsSync(p.scanProtocol)) {
    prompt += '\n\n' + fs.readFileSync(p.scanProtocol, 'utf8');
  }
  return prompt;
}

/**
 * Build user prompt for coding sessions.
 * Includes conditional hints based on session state.
 */
function buildCodingPrompt(sessionNum, opts = {}) {
  const p = paths();
  const config = loadConfig();
  const consecutiveFailures = opts.consecutiveFailures || 0;

  // Hint 1: Playwright MCP availability
  const mcpHint = config.mcpPlaywright
    ? '前端/全栈任务可用 Playwright MCP（browser_navigate、browser_snapshot、browser_click 等）做端到端测试。'
    : '';

  // Hint 2: Retry context from previous failures
  let retryContext = '';
  if (consecutiveFailures > 0 && opts.lastValidateLog) {
    retryContext = `\n注意：上次会话校验失败，原因：${opts.lastValidateLog}。请避免同样的问题。`;
  }

  // Hint 3: Environment readiness
  let envHint = '';
  if (consecutiveFailures === 0 && sessionNum > 1) {
    envHint = '环境已就绪，第二步可跳过 claude-coder init，仅确认服务存活。涉及新依赖时仍需运行 claude-coder init。';
  }

  // Hint 4: Existing test records
  let testHint = '';
  if (fs.existsSync(p.testsFile)) {
    try {
      const count = (JSON.parse(fs.readFileSync(p.testsFile, 'utf8')).test_cases || []).length;
      if (count > 0) testHint = `tests.json 已有 ${count} 条验证记录，Step 5 时先查已有记录避免重复验证。`;
    } catch { /* ignore */ }
  }

  // Hint 5: Project documentation awareness + profile quality check
  let docsHint = '';
  if (fs.existsSync(p.profile)) {
    try {
      const profile = JSON.parse(fs.readFileSync(p.profile, 'utf8'));
      const docs = profile.existing_docs || [];
      if (docs.length > 0) {
        docsHint = `项目文档: ${docs.join(', ')}。Step 4 编码前先读与任务相关的文档，了解接口约定和编码规范。完成后若新增了模块或 API，更新对应文档。`;
      }
      if (profile.tech_stack?.backend?.framework &&
          (!profile.services || profile.services.length === 0)) {
        docsHint += ' 注意：project_profile.json 的 services 为空，请在本次 session 末尾补全 services 数组（command, port, health_check）。';
      }
      if (!docs.length) {
        docsHint += ' 注意：project_profile.json 的 existing_docs 为空，请在 Step 6 收尾时补全文档列表。';
      }
    } catch { /* ignore */ }
  }

  // Hint 6: Task context (harness pre-read, saves Agent 2-3 Read calls)
  const projectRoot = getProjectRoot();
  let taskHint = '';
  try {
    const taskData = loadTasks();
    if (taskData) {
      const next = findNextTask(taskData);
      const stats = getStats(taskData);
      if (next) {
        taskHint = `任务上下文: ${next.id} "${next.description}" (${next.status}), ` +
          `category=${next.category}, steps=${next.steps.length}步。` +
          `进度: ${stats.done}/${stats.total} done, ${stats.failed} failed。` +
          `项目绝对路径: ${projectRoot}。运行时目录: ${projectRoot}/.claude-coder/（隐藏目录）。` +
          `第一步无需读取 tasks.json（已注入），直接确认任务后进入 Step 2。`;
      }
    }
  } catch { /* ignore */ }

  // Hint 6b: Test environment variables (readable + writable by Agent)
  let testEnvHint = '';
  if (p.testEnvFile && fs.existsSync(p.testEnvFile)) {
    testEnvHint = `测试凭证文件: ${projectRoot}/.claude-coder/test.env（含 API Key、测试账号等），测试前用 source ${projectRoot}/.claude-coder/test.env 加载。发现新凭证需求时可追加写入（KEY=value 格式）。`;
  } else {
    testEnvHint = `如需持久化测试凭证（API Key、测试账号密码等），写入 ${projectRoot}/.claude-coder/test.env（KEY=value 格式，每行一个）。后续 session 会自动感知。`;
  }

  // Hint 6c: Playwright authenticated state
  let playwrightAuthHint = '';
  if (p.playwrightAuth && fs.existsSync(p.playwrightAuth)) {
    playwrightAuthHint = `已检测到 Playwright 登录状态（${projectRoot}/.claude-coder/playwright-auth.json），前端/全栈测试将使用已认证的浏览器会话（含 cookies 和 localStorage）。`;
  }

  // Hint 7: Session memory (read flat session_result.json)
  let memoryHint = '';
  if (fs.existsSync(p.sessionResult)) {
    try {
      const sr = JSON.parse(fs.readFileSync(p.sessionResult, 'utf8'));
      if (sr?.task_id) {
        memoryHint = `上次会话: ${sr.task_id} → ${sr.status_after || sr.session_result}` +
          (sr.notes ? `, 要点: ${sr.notes.slice(0, 100)}` : '') + '。';
      }
    } catch { /* ignore */ }
  }

  // Hint 8: Service management (continuous vs single-shot mode)
  const maxSessions = opts.maxSessions || 50;
  const serviceHint = maxSessions === 1
    ? '单次模式：收尾时停止所有后台服务。'
    : '连续模式：收尾时不要停止后台服务，保持服务运行以便下个 session 继续使用。';

  // Hint 9: Tool usage guidance (critical for non-Claude models)
  const toolGuidance = [
    '可用工具与使用规范（严格遵守）：',
    '- 搜索文件名: Glob（如 **/*.ts），禁止 bash find',
    '- 搜索文件内容: Grep（正则，基于 ripgrep），禁止 bash grep',
    '- 读文件: Read（支持批量多文件同时读取），禁止 bash cat/head/tail',
    '- 列目录: LS，禁止 bash ls',
    '- 编辑文件: 同一文件多处修改用 MultiEdit（一次原子调用），单处用 Edit',
    '- 复杂搜索: Task（启动子 Agent 并行搜索，不消耗主 context），适合开放式探索',
    '- 查文档/API: WebSearch + WebFetch',
    '- 效率: 多个 Read/Glob/Grep 尽量合并为一次批量调用，减少工具轮次',
  ].join('\n');

  return [
    `Session ${sessionNum}。执行 6 步流程。`,
    '效率要求：先规划后编码，完成全部编码后再统一测试，禁止编码-测试反复跳转。后端任务用 curl 验证，不启动浏览器。',
    mcpHint,
    testHint,
    docsHint,
    envHint,
    taskHint,
    testEnvHint,
    playwrightAuthHint,
    memoryHint,
    serviceHint,
    toolGuidance,
    `完成后写入 session_result.json。${retryContext}`,
  ].filter(Boolean).join('\n');
}

/**
 * Build task decomposition guide for scan and add sessions.
 * Placed in user prompt (recency zone) for maximum attention.
 */
function buildTaskGuide(projectType) {
  const lines = [
    '任务分解指导（严格遵守）：',
    '1. 粒度：每个任务是独立可测试的功能单元，1-3 session 可完成，不超 500 行新增',
    '2. steps 具体可验证：最后一步必须是 curl/grep 等验证命令',
    '3. depends_on 形成 DAG（有向无环图），不得循环依赖',
    '4. 单任务 steps 不超过 5 步，超过则拆分为多个任务',
    '5. category 准确：backend | frontend | fullstack | infra',
    '6. 第一个任务从第一个有业务逻辑的功能开始，不重复脚手架内容',
    '',
    '验证命令模板：',
    '  API: curl -s -o /dev/null -w "%{http_code}" http://localhost:PORT/path → 200',
    '  文件: grep -q "关键内容" path/to/file && echo "pass"',
    '  构建: npm run build 2>&1 | tail -1 → 无 error',
    '',
    '反面案例（禁止出现）：',
    '  X "实现用户功能" → 太模糊，应拆为具体接口',
    '  X "编写测试" → 无具体内容，测试应内嵌在 steps 末尾',
    '  X steps 只有 "实现xxx" 没有验证步骤',
  ];

  if (projectType === 'new') {
    lines.push('', '新项目注意：infra 任务合并为尽量少的条目，不拆碎');
  }
  return lines.join('\n');
}

/**
 * Build user prompt for scan sessions.
 */
function buildScanPrompt(projectType, requirement) {
  const taskGuide = buildTaskGuide(projectType);
  return [
    '你是项目初始化 Agent，同时也是资深的需求分析师。',
    '',
    `项目类型: ${projectType}`,
    `用户需求: ${requirement || '(无指定需求)'}`,
    '',
    '步骤 1-2：按「项目扫描协议」扫描项目、生成 project_profile.json。',
    '',
    'profile 质量要求（必须遵守，harness 会校验）：',
    '- services 数组必须包含所有可启动服务（command、port、health_check），不得为空',
    '- existing_docs 必须列出所有实际存在的文档路径',
    '- 前后端分离项目必须生成 docs/ARCHITECTURE.md（模块职责、数据流、API 路由），并加入 existing_docs',
    '- scan_files_checked 必须列出所有实际扫描过的文件',
    '',
    '步骤 3：根据以下指导分解任务到 tasks.json（格式见 CLAUDE.md）：',
    '',
    taskGuide,
    '',
    '步骤 4：写入 session_result.json 并 git commit。',
  ].join('\n');
}

/**
 * Build user prompt for add sessions.
 * Structure: Role (primacy) → Context → CoT → TaskGuide → Instruction (recency)
 */
function buildAddPrompt(instruction) {
  const p = paths();
  const projectRoot = getProjectRoot();
  const taskGuide = buildTaskGuide();

  // --- Context injection: pre-read project state ---
  let profileContext = '';
  if (fs.existsSync(p.profile)) {
    try {
      const profile = JSON.parse(fs.readFileSync(p.profile, 'utf8'));
      const stack = profile.tech_stack || {};
      const parts = [];
      if (stack.backend?.framework) parts.push(`后端: ${stack.backend.framework}`);
      if (stack.frontend?.framework) parts.push(`前端: ${stack.frontend.framework}`);
      if (stack.backend?.language) parts.push(`语言: ${stack.backend.language}`);
      if (parts.length) profileContext = `项目技术栈: ${parts.join(', ')}`;
    } catch { /* ignore */ }
  }

  let taskContext = '';
  let recentExamples = '';
  try {
    const taskData = loadTasks();
    if (taskData) {
      const stats = getStats(taskData);
      const features = taskData.features || [];
      const maxId = features.length ? features[features.length - 1].id : 'feat-000';
      const maxPriority = features.length ? Math.max(...features.map(f => f.priority || 0)) : 0;
      const categories = [...new Set(features.map(f => f.category))].join(', ');

      taskContext = `已有 ${stats.total} 个任务（${stats.done} done, ${stats.pending} pending, ${stats.failed} failed）。` +
        `最大 id: ${maxId}, 最大 priority: ${maxPriority}。已有 category: ${categories}。`;

      const recent = features.slice(-3);
      if (recent.length) {
        recentExamples = '已有任务格式参考（保持一致性）：\n' +
          recent.map(f => `  ${f.id}: "${f.description}" (category=${f.category}, steps=${f.steps.length}步, depends_on=[${f.depends_on.join(',')}])`).join('\n');
      }
    }
  } catch { /* ignore */ }

  return [
    // --- Primacy zone: role + identity ---
    '你是资深需求分析师，擅长将模糊需求分解为可执行的原子任务。',
    '这是任务追加 session，不是编码 session。你只分解任务，不实现代码。',
    '',

    // --- Context layer ---
    profileContext,
    taskContext,
    recentExamples,
    `项目绝对路径: ${projectRoot}`,
    '',

    // --- CoT: explicit thinking steps ---
    '执行步骤（按顺序，不可跳过）：',
    '1. 读取 .claude-coder/tasks.json 和 .claude-coder/project_profile.json，全面了解项目现状',
    '2. 分析用户指令：识别核心功能点，判断是单任务还是需要拆分为多任务',
    '3. 检查重复：对比已有任务，避免功能重叠',
    '4. 确定依赖：新任务的 depends_on 引用已有或新增任务的 id，形成 DAG',
    '5. 分解任务：每个任务对应一个独立可测试的功能单元，description 简明（40字内），steps 具体可操作',
    '6. 追加到 tasks.json，id 和 priority 从已有最大值递增，status: pending',
    '7. git add -A && git commit -m "chore: add new tasks"',
    '8. 写入 session_result.json',
    '',

    // --- Quality constraints ---
    taskGuide,
    '',
    '不修改已有任务，不实现代码。',
    '',

    // --- Recency zone: user instruction (highest attention) ---
    `用户指令：${instruction}`,
  ].filter(Boolean).join('\n');
}

module.exports = {
  buildSystemPrompt,
  buildCodingPrompt,
  buildTaskGuide,
  buildScanPrompt,
  buildAddPrompt,
};
