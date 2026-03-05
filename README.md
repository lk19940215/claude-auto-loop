# Claude Coder

**中文** | [English](docs/README.en.md)

受 [Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) 启发，Claude Coder 是一个**自主编码 harness**，依托 Claude Agent SDK 的 `query()` 接口，提供项目扫描、任务分解、多 session 编排、自动校验与 git 回滚的能力，支持一句话需求或 `requirements.md` 驱动，兼容所有 Anthropic API 兼容的模型提供商。

**核心思路**：AI Agent 单次会话上下文有限，大型需求容易丢失进度或产出不可用代码。本工具将 Agent 包装为一个**可靠的、可重试的函数** — harness 管理任务状态、校验每次产出、失败时自动回滚，Agent 只需专注于编码。

---

## 快速上手

```bash
# 前置：安装 Claude Agent SDK
npm install -g @anthropic-ai/claude-agent-sdk

# 安装
npm install -g claude-coder

# 配置模型
claude-coder setup

# 开始自动编码
cd your-project
claude-coder run "实现用户注册和登录功能"
```

## 工作原理

```
需求输入 ─→ 项目扫描 ─→ 任务分解 ─→ 编码循环
                                       │
                                 ┌──────┴──────┐
                                 │  Session N   │
                                 │  Claude SDK  │
                                 │  6 步流程    │
                                 └──────┬──────┘
                                        │
                                   harness 校验
                                        │
                              通过 → 下一个任务
                              失败 → git 回滚 + 重试
```

每个 session 内，Agent 自主执行 6 步：恢复上下文 → 环境检查 → 选任务 → 编码 → 测试 → 收尾（git commit）。

## 命令

| 命令 | 说明 |
|------|------|
| `claude-coder setup` | 交互式模型配置 |
| `claude-coder run [需求]` | 自动编码循环 |
| `claude-coder run --max 1` | 单次执行 |
| `claude-coder run --dry-run` | 预览模式 |
| `claude-coder init` | 初始化项目环境 |
| `claude-coder add "指令"` | 追加任务 |
| `claude-coder add -r [file]` | 从需求文件追加任务 |
| `claude-coder add "..." --model M` | 指定模型追加任务 |
| `claude-coder auth [url]` | 导出 Playwright 登录状态 |
| `claude-coder validate` | 手动校验 |
| `claude-coder status` | 查看进度和成本 |
| `claude-coder config sync` | 同步配置到 ~/.claude/ |

**选项**：`--max N` 限制 session 数（默认 50），`--pause N` 每 N 个 session 暂停确认（默认不暂停）。

## 使用场景

**新项目**：`claude-coder run "用 Express + React 做 Todo 应用"` — 自动搭建脚手架、分解任务、逐个实现。

**已有项目**：`claude-coder run "新增头像上传功能"` — 先扫描现有代码和技术栈，再增量开发。

**需求文档驱动**：在项目根目录创建 `requirements.md`，运行 `claude-coder run` — 需求变更后用 `claude-coder add -r` 同步新任务。

**追加任务**：`claude-coder add "新增管理员后台"` 或 `claude-coder add -r requirements.md` — 仅追加到任务列表，下次 run 时执行。

**自动测试 + 凭证持久化**：`claude-coder auth http://localhost:3000` — 导出浏览器登录态（cookies + localStorage），Agent 测试时自动使用。缺 API Key 时 Agent 会自行记录到 `test.env` 并继续推进，不会停工。详见 [测试凭证持久化方案](docs/PLAYWRIGHT_CREDENTIALS.md)。

## 模型支持

| 提供商 | 说明 |
|--------|------|
| Claude 官方 | 默认，Anthropic 原版 API |
| GLM (智谱/Z.AI) | GLM 4.7 / GLM 5 |
| 阿里云百炼 | qwen3-coder-plus / glm-5 |
| DeepSeek | deepseek-chat / reasoner |
| 自定义 | 任何 Anthropic 兼容 API |

## 项目结构

```
your-project/
  .claude-coder/              # 运行时数据（gitignored）
    .env                    # 模型配置
    project_profile.json    # 项目扫描结果
    tasks.json              # 任务列表 + 状态
    session_result.json     # 上次 session 结果（扁平）
    progress.json           # 会话历史 + 成本
    tests.json              # 验证记录
    test.env                # 测试凭证（API Key 等，可选）
    playwright-auth.json    # Playwright 登录状态（可选，auth 命令生成）
    .runtime/               # 临时文件
      logs/                 # 每 session 独立日志 + activity log
  requirements.md           # 需求文档（可选）
```

## 常见问题

**"Credit balance is too low"**：运行 `claude-coder setup` 重新配置 API Key。

**中断恢复**：直接重新运行 `claude-coder run`，会从上次中断处继续。

**长时间无响应**：模型处理复杂文件时可能出现 10-20 分钟的思考间隔（spinner 会显示红色警告），这是正常行为。超过 30 分钟无工具调用时 Harness 会自动中断并重试。可通过 `.env` 中 `SESSION_STALL_TIMEOUT=秒数` 调整阈值。

**跳过任务**：将 `.claude-coder/tasks.json` 中该任务的 `status` 改为 `done`。

**Windows 支持**：完全支持，纯 Node.js 实现。

## 文档

- [技术架构](docs/ARCHITECTURE.md) — 核心设计规则、模块职责、提示语注入架构、注意力机制、Hook 数据流
- [测试凭证持久化方案](docs/PLAYWRIGHT_CREDENTIALS.md) — 自动测试的凭证管理：Playwright 登录态导出、API Key 持久化、Agent 缺凭证时的行为策略

## License

MIT
