# Claude Coder — 技术架构文档

> 本文件面向开发者和 AI，用于快速理解本工具的设计、文件结构、提示语架构和扩展方向。

---

## 一句话定位

一个基于 Claude Agent SDK 的**自主编码 harness**：自动扫描项目 → 拆解任务 → 逐个实现 → 校验 → 回滚/重试 → 推送，全程无需人工干预。

---

## 0. 核心设计规则（MUST READ）

> 以下规则按重要性排序（注意力 primacy zone），所有代码修改和架构决策必须遵循。

### 规则 1：长 Session 不停工

Agent 在单次 session 中应最大化推进任务进度。**任何非致命问题都不应中断 session**。

- 缺少 API Key → 用 mock 或代码逻辑验证替代，记录到 `test.env`，继续推进
- 测试环境未就绪 → 跳过该测试步骤，完成其余可验证的步骤
- 服务启动失败 → 尝试排查修复，无法修复则记录问题后推进代码实现
- **长时间思考是正常行为**：模型处理大文件（如 500+ 行的代码文件）时可能出现 10-20 分钟的思考间隔，不代表卡死

**反面案例**：Agent 因 `OPENAI_API_KEY` 缺失直接标记任务 `failed` → 浪费整个 session

> Harness 兜底机制：当工具调用间隔超过 `SESSION_STALL_TIMEOUT`（默认 30 分钟）时自动中断 session 并触发 rollback + 重试。此阈值设计为远超正常思考时长，仅捕捉真正的卡死场景。

### 规则 2：回滚即彻底回滚

`git reset --hard` 是全量回滚，不做部分文件保护。

- 凭证文件（`test.env`、`playwright-auth.json`）应通过 `.gitignore` 排除在 git 之外
- 如果回滚发生，说明 session 确实失败，代码应全部还原
- 不需要 backup/restore 机制 — 这是过度设计

### 规则 3：分层校验（fatal / recoverable / pass）

不是所有校验失败都需要回滚：

| 情况 | 有新 commit | 处理 |
|------|------------|------|
| session_result.json 格式异常 | 是 | **warn** — 代码已提交且可能正确，不回滚 |
| session_result.json 格式异常 | 否 | **fatal** — 无进展，回滚 |
| 代码结构性错误 | — | **fatal** — 回滚 |
| 全部通过 | — | **pass** — 推送 |

### 规则 4：凭证与代码分离

| 文件 | git 状态 | 说明 |
|------|---------|------|
| `test.env` | .gitignore | Agent 可写入发现的 API Key、测试账号 |
| `playwright-auth.json` | .gitignore | 用户通过 `claude-coder auth` 生成 |
| `session_result.json` | git-tracked | Agent 每次 session 覆盖写入 |
| `tasks.json` | git-tracked | Agent 修改 status 字段 |

### 规则 5：Harness 准备上下文，Agent 直接执行

Agent 不应浪费工具调用读取 harness 已知的数据。所有可预读的上下文通过 prompt hint 注入（见第 5 节 Prompt 注入架构）。

### 规则 6：停顿检测 — 模型卡死自动恢复

模型可能长时间「思考」但不调用工具（20+ 分钟无进展）。Harness 通过 PreToolUse hook 追踪最后一次工具调用时间：

- 无工具调用 > `SESSION_STALL_TIMEOUT`（默认 1800 秒 / 30 分钟） → 自动中断 session
- 中断后进入 runner 的重试逻辑（连续失败 ≥ 3 次 → 标记 task failed）
- Spinner 在无工具调用 > 2 分钟时显示红色警告

配置方式：`.claude-coder/.env` 中设置 `SESSION_STALL_TIMEOUT=1800`（秒）

---

## 1. 核心架构

```mermaid
flowchart TB
    subgraph Harness["bin/cli.js → src/runner.js (Harness 主控)"]
        direction TB
        scan["scanner.scan()<br/>首次扫描"]
        coding["session.runCodingSession()<br/>编码循环"]
        validate["validator.validate()<br/>校验"]
        indicator["Indicator 类<br/>setInterval 500ms 刷新"]
    end

    subgraph SDK["Claude Agent SDK"]
        query["query() 函数"]
        hook_sys["PreToolUse hook<br/>内联回调"]
    end

    subgraph Files["文件系统 (.claude-coder/)"]
        direction TB
        profile["project_profile.json<br/>tasks.json"]
        runtime["session_result.json<br/>progress.json"]
        phase[".runtime/<br/>phase / step / logs/"]
    end

    scan -->|"systemPrompt =<br/>CLAUDE.md + SCAN_PROTOCOL.md"| query
    coding -->|"systemPrompt = CLAUDE.md"| query

    query -->|PreToolUse 事件| hook_sys
    hook_sys -->|inferPhaseStep()| indicator

    query -->|Agent 工具调用| Files
    validate -->|读取| runtime
    validate -->|"pass → 下一 session<br/>fatal → rollback<br/>recoverable + commit → warn"| coding
```

**核心特征：**
- **项目无关**：项目信息由 Agent 扫描后存入 `project_profile.json`，harness 不含项目特定逻辑
- **可恢复**：通过 `session_result.json` 跨会话记忆，任意 session 可断点续跑
- **可观测**：SDK 内联 `PreToolUse` hook 实时显示当前工具、操作目标和停顿警告
- **自愈**：编辑死循环检测 + 停顿超时自动中断 + runner 重试机制
- **跨平台**：纯 Node.js 实现，macOS / Linux / Windows 通用
- **零依赖**：`dependencies` 为空，Claude Agent SDK 作为 peerDependency

---

## 2. 执行流程

```mermaid
flowchart LR
    start(["claude-coder run ..."]) --> mode{模式?}

    mode -->|"add 指令"| add["runAddSession()"]
    add --> exit_add([exit 0])

    mode -->|run| check{profile<br/>存在?}

    check -->|否| req["读取<br/>requirements.md"]
    req --> scan["scanner.scan()"]
    scan --> profile_out["生成<br/>profile + tasks.json"]
    profile_out --> loop

    check -->|是| loop

    loop["编码循环"] --> session["runCodingSession(N)"]
    session --> val["validator.validate()"]
    val -->|pass| push["git push"]
    push --> done_check{所有任务<br/>done?}
    done_check -->|否| pause_check{每N个session<br/>暂停?}
    pause_check -->|继续| session
    done_check -->|是| finish([完成])

    val -->|fatal| rollback["git reset --hard"]
    rollback --> retry_check{连续失败<br/>≥3次?}
    retry_check -->|否| session
    retry_check -->|是| mark_failed["标记 task failed"]
    mark_failed --> session
```

---

## 3. 模块职责

```
bin/cli.js          CLI 入口：参数解析、命令路由、SDK peerDep 检查
src/
  config.js         配置管理：.env 加载、模型映射、环境变量构建、全局同步
  runner.js         主循环：scan → session → validate → retry/rollback
  session.js        SDK 交互：query() 调用、hook 绑定、停顿检测、日志流
  prompts.js        提示语构建：系统 prompt 组合 + 条件 hint + 任务分解指导
  init.js           环境初始化：读取 profile 执行依赖安装、服务启动、健康检查
  scanner.js        初始化扫描：调用 runScanSession + 重试
  validator.js      校验引擎：分层校验（fatal/recoverable/pass）+ git 检查 + 测试覆盖
  tasks.js          任务管理：CRUD + 状态机 + 进度展示
  auth.js           Playwright 凭证：导出登录状态 + MCP 配置 + gitignore
  indicator.js      进度指示：终端 spinner + 工具目标显示 + 停顿警告 + phase/step 文件写入
  setup.js          交互式配置：模型选择、API Key、MCP 工具
templates/
  CLAUDE.md         Agent 协议（注入为 systemPrompt）
  SCAN_PROTOCOL.md  首次扫描协议（与 CLAUDE.md 拼接注入）
  requirements.example.md  需求文件模板
```

---

## 4. 文件清单

### npm 包分发内容

| 文件 | 用途 |
|------|------|
| `bin/cli.js` | CLI 入口 |
| `src/config.js` | .env 加载、模型映射 |
| `src/runner.js` | Harness 主循环 |
| `src/session.js` | SDK query() 封装 + hook |
| `src/prompts.js` | 提示语构建（系统 prompt + 条件 hint + 任务分解指导） |
| `src/init.js` | 环境初始化（依赖安装、服务启动） |
| `src/scanner.js` | 项目初始化扫描 |
| `src/validator.js` | 校验引擎（分层校验） |
| `src/tasks.js` | 任务 CRUD + 状态机 |
| `src/auth.js` | Playwright 凭证持久化 |
| `src/indicator.js` | 终端进度指示器 |
| `src/setup.js` | 交互式配置向导 |
| `templates/CLAUDE.md` | Agent 协议 |
| `templates/SCAN_PROTOCOL.md` | 首次扫描协议 |

### 用户项目运行时数据（.claude-coder/）

| 文件 | 生成时机 | 用途 |
|------|----------|------|
| `.env` | `claude-coder setup` | 模型配置 + API Key（gitignored） |
| `project_profile.json` | 首次扫描 | 项目元数据 |
| `tasks.json` | 首次扫描 | 任务列表 + 状态跟踪 |
| `progress.json` | 每次 session 结束 | 结构化会话日志 + 成本记录 |
| `session_result.json` | 每次 session 结束 | 当前 session 结果（扁平格式，向后兼容旧 `current` 包装） |
| `playwright-auth.json` | `claude-coder auth` | Playwright 登录状态（cookies + localStorage） |
| `tests.json` | 首次测试时 | 验证记录（防止反复测试） |
| `.runtime/` | 运行时 | 临时文件（phase、step、logs/session_N.activity.log） |

---

## 5. Prompt 注入架构

### 架构图

```mermaid
flowchart TB
    subgraph Templates["templates/ (静态模板)"]
        claude_md["CLAUDE.md<br/>Agent 协议 ~255 行"]
        scan_md["SCAN_PROTOCOL.md<br/>扫描协议 ~133 行"]
    end

    subgraph Prompts["src/prompts.js (动态构建)"]
        sys_p["buildSystemPrompt()<br/>组合系统提示"]
        coding_p["buildCodingPrompt()<br/>编码 session prompt"]
        task_g["buildTaskGuide()<br/>任务分解指导"]
        scan_p["buildScanPrompt()<br/>扫描 session prompt"]
        add_p["buildAddPrompt()"]
    end

    subgraph Session["src/session.js (SDK 调用)"]
        query["SDK query()<br/>systemPrompt + prompt"]
    end

    claude_md --> sys_p
    scan_md --> sys_p
    sys_p --> query
    coding_p --> query
    task_g --> scan_p
    task_g --> add_p
    scan_p --> query
    add_p --> query
```

### Session 类型与注入内容

| Session 类型 | systemPrompt | user prompt | 触发条件 |
|---|---|---|---|
| **编码** | CLAUDE.md | `buildCodingPrompt()` + 11 个条件 hint | 主循环每次迭代 |
| **扫描** | CLAUDE.md + SCAN_PROTOCOL.md | `buildScanPrompt()` + 任务分解指导 + profile 质量要求 | 首次运行 |
| **追加** | CLAUDE.md | `buildAddPrompt()` + 任务分解指导 | `claude-coder add` |

### 编码 Session 的 11 个条件 Hint

| # | Hint | 触发条件 | 影响 |
|---|---|---|---|
| 1 | `mcpHint` | MCP_PLAYWRIGHT=true | Step 5：可用 Playwright |
| 2 | `retryContext` | 上次校验失败 | 全局：避免同样错误 |
| 3 | `envHint` | 连续成功且 session>1 | Step 2：跳过 init |
| 4 | `testHint` | tests.json 有记录 | Step 5：避免重复验证 |
| 5 | `docsHint` | profile.existing_docs 非空或 profile 有缺陷 | Step 4：读文档后再编码；profile 缺陷时提示 Agent 在 Step 6 补全 services/docs |
| 6 | `taskHint` | tasks.json 存在且有待办任务 | Step 1：跳过读取 tasks.json，harness 已注入当前任务上下文 + 项目绝对路径 |
| 6b | `testEnvHint` | 始终注入（内容因 test.env 是否存在而不同） | Step 5：存在时提示加载；不存在时告知可创建 |
| 6c | `playwrightAuthHint` | .claude-coder/playwright-auth.json 存在 | Step 5：提示 Agent 前端测试可使用已认证的浏览器状态 |
| 7 | `memoryHint` | session_result.json 存在（扁平格式） | Step 1：跳过读取 session_result.json，harness 已注入上次会话摘要 |
| 8 | `serviceHint` | 始终注入 | Step 6：单次模式停止服务，连续模式保持服务运行 |
| 9 | `toolGuidance` | 始终注入 | 全局：工具使用规范（Grep/Glob/Read/LS/MultiEdit/Task 替代 bash 命令），非 Claude 模型必需 |

---

## 6. 注意力机制与设计决策

### U 型注意力优化

CLAUDE.md 的内容按 LLM 注意力 U 型曲线排列：

```
顶部 (primacy zone)    → 铁律（约束规则）      → 最高遵循率
中部 (低注意力区)      → 参考数据（文件格式等） → 按需查阅
底部 (recency zone)    → 6 步工作流（行动指令） → 最高行为合规率
```

### 关键设计决策

| 决策 | 理由 |
|------|------|
| **静态规则 vs 动态上下文分离** | CLAUDE.md 是"宪法"（低频修改），hints 依赖运行时状态（动态生成） |
| **扫描协议单独文件** | 仅首次注入，编码 session 不需要，节省 ~2000 token |
| **任务分解指导在 user prompt** | 从系统 prompt 中部（低注意力）迁移到 user prompt（recency zone），提升遵循率 |
| **docsHint 动态注入** | 当 profile.existing_docs 非空时，在 user prompt 提醒 Agent 读文档再编码。CLAUDE.md Step 4 有静态指令，docsHint 在 recency zone 强化 |
| **tests.json 保留 last_run_session** | Agent 判断是否需要重新验证的依据（代码可能在中间 session 被修改） |
| **prompts.js 集中管理** | 所有 prompt 文本一处可见，与 session.js 的 SDK 交互职责分离 |

### 学术依据

| 优化项 | 理论来源 |
|---|---|
| U 型注意力布局 | Anthropic Context Engineering |
| DAG 依赖约束 | ACONIC (2025, arXiv 2510.07772) |
| 反面案例排除 | SCoT (2023) + Expert Context Framework |
| scan/add 复用 taskGuide | User Story Decomposition (SSRN 2025) |

---

## 7. Hook 数据流

SDK 的 hooks 是**进程内回调**（非独立进程），零延迟、无 I/O 开销：

```mermaid
sequenceDiagram
    participant SDK as Claude Agent SDK
    participant Hook as inferPhaseStep()
    participant Ind as Indicator (setInterval)
    participant Stall as stallChecker (30s)
    participant Term as 终端

    SDK->>Hook: PreToolUse 回调<br/>{tool_name: "Edit", tool_input: {path: "src/app.tsx"}}
    Hook->>Hook: 推断阶段: Edit → coding
    Hook->>Ind: updatePhase("coding")
    Hook->>Ind: lastToolTime = now
    Hook->>Ind: toolTarget = "src/app.tsx"
    Hook->>Ind: appendActivity("Edit", "src/app.tsx")

    Note over SDK,Hook: 同步回调，return {decision: "allow"}

    loop 每 500ms
        Ind->>Term: ⠋ [Session 3] 编码中 02:15 | 读取文件: ppt_generator.py
    end

    loop 每 30s
        Stall->>Ind: 检查 now - lastToolTime
        alt 超过 STALL_TIMEOUT
            Stall->>SDK: stallDetected = true → break for-await
        end
    end
```

---

## 8. 评分

| 维度 | 评分 | 说明 |
|------|------|------|
| **CLAUDE.md 系统提示** | 8/10 | U 型注意力设计；铁律清晰；状态机和 6 步流程是核心竞争力 |
| **动态 prompt** | 9/10 | 10 个条件 hint 精准注入，含 task/memory 上下文注入 + cwd 路径 + test.env + 服务管理 + 工具使用指导，减少 Agent 冗余操作 |
| **SCAN_PROTOCOL.md** | 8.5/10 | 新旧项目分支完整，profile 格式全面 |
| **tests.json 设计** | 7.5/10 | 精简字段，核心目的（防反复测试）明确 |
| **注入时机** | 9/10 | 静态规则 vs 动态上下文分离干净 |
| **整体架构** | 8/10 | 文件组织清晰，prompts.js 分离提升可维护性 |

---

## 9. Context Injection 架构（v1.0.4+）

### 设计原则

**Harness 准备上下文，Agent 直接执行。** Agent 不应浪费工具调用读取 harness 已知的数据。

### 优化前后对比

```mermaid
flowchart TD
    subgraph before ["优化前：Agent 自行读取"]
        A1[Agent starts] --> A2["Read tasks.json"]
        A2 --> A3["Read profile.json"]
        A3 --> A4["Read session_result.json"]
        A4 --> A5["Read requirements.md"]
        A5 --> A6["Read tests.json"]
        A6 --> A7["开始编码（5+ Read 调用浪费）"]
    end

    subgraph after ["优化后：Harness 注入上下文"]
        B1["Harness 预读文件"] --> B2["注入 Hint 7: 任务上下文"]
        B1 --> B3["注入 Hint 8: 会话记忆"]
        B2 --> B4["Agent prompt 就绪"]
        B3 --> B4
        B4 --> B5["Agent 直接开始编码"]
    end
```

### Hint 7: 任务上下文注入

Harness 在 `buildCodingPrompt()` 中预读 `tasks.json`，将下一个待办任务的 id、description、category、steps 数量和整体进度注入 user prompt。Agent 无需自行读取 `tasks.json`。

### Hint 8: 会话记忆注入

Harness 在 `buildCodingPrompt()` 中预读 `session_result.json`，将上次会话的 task_id、结果和 notes 摘要注入 user prompt。Agent 无需自行读取历史 session 数据。

### 自愈机制

**编辑死循环检测**：PreToolUse hook 追踪每个文件的编辑次数，同一文件 Write/Edit 超 5 次 → `decision: "block"`。

**停顿超时检测**：每 30 秒检查 `indicator.lastToolTime`，若距上次工具调用超过 `SESSION_STALL_TIMEOUT`（默认 1800 秒 / 30 分钟），自动 `break` 退出并触发 rollback + 重试。
> 注意：模型在处理复杂文件时可能出现 10-20 分钟的长时间思考，这是正常行为。超时设为 30 分钟以避免误杀正常思考。可通过 `.env` 中 `SESSION_STALL_TIMEOUT=秒数` 自定义。

### 文件权限模型

| 文件 | 写入方 | Agent 权限 | git 状态 |
|------|--------|-----------|---------|
| `progress.json` | Harness | 只读 | tracked |
| `session_result.json` | Agent 每次 session 覆盖写入（扁平格式） | 写入 | tracked |
| `tasks.json` | Agent（仅 `status` 字段） | 修改 `status` | tracked |
| `project_profile.json` | Agent（仅扫描阶段） | 扫描时写入 | tracked |
| `test.env` | Agent + 用户 | 可追加写入 | .gitignore |
| `playwright-auth.json` | 用户（`claude-coder auth`） | 只读 | .gitignore |

---

## 10. Claude Agent SDK V1/V2 对比与迁移计划

当前使用 **V1 稳定 API**（`query()`），V2 为 preview 状态（`unstable_` 前缀）。

### V1 vs V2 API 对比

| 维度 | V1 `query()` | V2 `send()/stream()` |
|------|-------------|---------------------|
| **状态** | 稳定，生产可用 | `unstable_` 前缀，preview |
| **入口函数** | `query({ prompt, options })` | `unstable_v2_createSession(opts)` / `unstable_v2_prompt()` |
| **多轮会话** | 需手动管理 AsyncGenerator | `session.send()` + `session.stream()`，更简洁 |
| **会话恢复** | `options.resume: sessionId` | `unstable_v2_resumeSession(id)` |
| **Hooks** | `options.hooks: { PreToolUse, PostToolUse, ... }` | 未支持 |
| **Subagents** | `options.agents: { name: AgentDefinition }` | 未支持 |
| **Session Fork** | `options.forkSession: true` | 未支持 |
| **Plugins** | `options.plugins: [{ type, path }]` | 未支持 |
| **结构化输出** | `options.outputFormat: { type: 'json_schema', schema }` | 支持 |
| **文件检查点** | `options.enableFileCheckpointing + rewindFiles()` | 未明确 |
| **Cost Tracking** | `SDKResultMessage.total_cost_usd` | `SDKResultMessage.total_cost_usd` |
| **权限控制** | `canUseTool`, `permissionMode`, `allowedTools`, `disallowedTools` | 继承 |

### 当前实现使用的 V1 特性

```javascript
query({
  prompt,
  options: {
    systemPrompt,                      // 注入 CLAUDE.md
    allowedTools,                      // 工具白名单
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    model,                             // 从 .env 传入
    env,                               // 环境变量透传
    settingSources: ['project'],       // 加载项目 CLAUDE.md
    hooks: { PreToolUse: [...] },      // 实时 spinner 监控
  }
})
```

### V2 迁移条件（等待稳定后）

1. V2 去掉 `unstable_` 前缀，正式发布
2. V2 支持 Hooks（当前项目依赖 PreToolUse 做 spinner 和 activity log）
3. V2 支持 Subagents（未来可能用于扫描 Agent / 编码 Agent 分离）

### 可利用但尚未使用的 V1 特性

| 特性 | 说明 | 优先级 |
|------|------|--------|
| `maxBudgetUsd` | SDK 内置成本上限，替代自研追踪 | P0 |
| `effort` | 控制思考深度（`low`/`medium`/`high`/`max`） | P1 |
| `enableFileCheckpointing` | 文件操作检查点，比 git reset 更精细 | P1 |
| `outputFormat` | 结构化输出，让 Agent 直接输出 JSON 格式 | P1 |
| `agents` | 定义子 Agent，不同模型/工具集 | P2 |
| `betas` | 扩展上下文窗口 | P2 |

---

## 11. 后续优化方向

### P0 — 近期

| 方向 | 说明 |
|------|------|
| **文件保护 Deny-list** | PreToolUse hook 拦截对保护文件的写入（比文字规则更硬性） |
| **成本预算控制** | `.env` 新增 `MAX_COST_USD`，超预算自动停止 |

### P1 — 中期

| 方向 | 说明 |
|------|------|
| **TCR 纪律** | Test && Commit \|\| Revert，可配置 strict/smart/off |
| **配置分层** | defaults.env → .env → .env.local 三层合并 |
| **Reminders 注入** | 用户自定义提醒文件，拼接到编码 prompt |
| **MCP 工具自动检测** | `claude mcp list` 自动启用已安装工具 |

### P2 — 远期

| 方向 | 说明 |
|------|------|
| **TUI 终端监控** | 基于 ANSI 的全屏界面，替代单行 spinner |
| **Web UI 监控** | 可选插件包 `@claude-coder/web-ui` |
| **PR/CI 集成** | Session 完成后自动创建 PR、监控 CI |
| **Prompt A/B 测试** | 多版本 CLAUDE.md 并行对比效果 |
| **并行 Worktree** | 多任务在不同 git worktree 中并行执行 |

---

## 实现原则

> 核心设计规则见 Section 0（primacy zone），以下为实现层面的补充原则。

1. **SDK 原生集成**：通过 `query()` 调用 Claude，内联 hooks，原生 cost tracking
2. **零硬依赖**：Claude Agent SDK 作为 peerDependency
3. **幂等设计**：所有入口可重复执行，不产生副作用
4. **跨平台**：纯 Node.js + `child_process` 调用 git，无平台特定脚本
5. **运行时隔离**：每个项目的 `.claude-coder/` 独立，不同项目互不干扰
6. **文档即上下文**：Blueprint（`project_profile.json`）给 harness，Context Docs 给 Agent。Hint 6 动态提醒 Agent 读取相关文档

### 文档架构的学术依据

| 来源 | 核心概念 | 本项目映射 |
|------|----------|-----------|
| DeepCode (arXiv 2512.07921) | Blueprint Distillation — 源文档压缩为结构化蓝图 | `project_profile.json` 是项目蓝图 |
| CodeMem (arXiv 2512.15813) | Procedural Memory — 验证过的逻辑持久化为可索引技能库 | 架构文档记录"决策"供 Agent 按需检索 |
| Anthropic Memory Tool | Just-in-time 检索 — 按需从文件系统拉取 | Hint 6 按需提示 Agent 读文档 |
| ContextBench (arXiv 2602.05892) | 复杂脚手架边际收益递减 | 不过度设计文档体系，关键信息必须准确 |
| LangChain Harness Engineering | Build-Verify + Context on behalf of Agent | Harness 准备上下文，Agent 专注编码 |
