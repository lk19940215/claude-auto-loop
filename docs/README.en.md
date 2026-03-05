# Claude Coder

[中文](../README.md) | **English**

Inspired by [Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), Claude Coder is an **autonomous coding harness** built on the Claude Agent SDK's `query()` interface. It provides project scanning, task decomposition, multi-session orchestration, automatic validation, and git rollback — driven by a one-liner requirement or a `requirements.md` file, compatible with all Anthropic API-compatible model providers.

**Core idea**: A single AI session has limited context. For large requirements, agents tend to lose progress or produce broken code. This tool wraps the agent in a **reliable, retryable function** — the harness manages task state, validates every output, and auto-rolls back on failure. The agent just focuses on coding.

---

## Quick Start

```bash
# Prerequisites: Install Claude Agent SDK
npm install -g @anthropic-ai/claude-agent-sdk

# Install
npm install -g claude-coder

# Configure model
claude-coder setup

# Start auto-coding
cd your-project
claude-coder run "Implement user registration and login"
```

## How It Works

```
Requirement ─→ Project scan ─→ Task decomposition ─→ Coding loop
                                                       │
                                                 ┌─────┴─────┐
                                                 │  Session N  │
                                                 │  Claude SDK │
                                                 │  6-step flow│
                                                 └─────┬─────┘
                                                       │
                                                  Harness validate
                                                       │
                                             Pass → next task
                                             Fail → git rollback + retry
```

Each session, the agent autonomously follows 6 steps: restore context → env check → pick task → code → test → commit.

## Commands

| Command | Description |
|---------|-------------|
| `claude-coder setup` | Interactive model configuration |
| `claude-coder run [requirement]` | Auto-coding loop |
| `claude-coder run --max 1` | Single session (replaces old view mode) |
| `claude-coder run --dry-run` | Preview mode |
| `claude-coder init` | Initialize project environment |
| `claude-coder add "instruction"` | Append tasks |
| `claude-coder add -r [file]` | Append tasks from requirements file |
| `claude-coder add "..." --model M` | Append tasks with specific model |
| `claude-coder auth [url]` | Export Playwright login state |
| `claude-coder validate` | Manually validate last session |
| `claude-coder status` | View progress and costs |
| `claude-coder config sync` | Sync config to ~/.claude/ |

**Options**: `--max N` limit sessions (default 50), `--pause N` pause every N sessions (default: no pause).

## Model Support

| Provider | Description |
|----------|-------------|
| Claude (Official) | Default, Anthropic native API |
| GLM (Zhipu/Z.AI) | GLM 4.7 / GLM 5 |
| Aliyun Bailian | qwen3-coder-plus / glm-5 |
| DeepSeek | deepseek-chat / reasoner |
| Custom | Any Anthropic-compatible API |

## Project Structure

```
your-project/
  .claude-coder/              # Runtime data (gitignored)
    .env                    # Model config
    project_profile.json    # Project scan results
    tasks.json              # Task list + status
    session_result.json     # Last session result (flat)
    progress.json           # Session history + costs
    tests.json              # Verification records
    test.env                # Test credentials (API keys, optional)
    playwright-auth.json    # Playwright login state (optional, via auth command)
    .runtime/               # Temp files
      logs/                 # Per-session logs (with tool call traces)
  requirements.md           # Requirements (optional)
```

## Documentation

- [Architecture](ARCHITECTURE.md) — Module responsibilities, prompt injection architecture, attention mechanism, hook data flow, future roadmap
- [Playwright Credentials](PLAYWRIGHT_CREDENTIALS.md) — Test cookies and API key management

## License

MIT
