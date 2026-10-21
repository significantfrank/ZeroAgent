# ZeroAgent

ZeroAgent 是一组循序渐进的 TypeScript 教程项目，演示如何基于 OpenAI Responses API 构建流式 ReAct Agent。各 chapter 是独立 workspace package，从 API 基础能力一路扩展到工具调用、MCP、Skills、持久化会话和可复用 slash commands。

## 学习路径

| Chapter | 内容 |
| --- | --- |
| [chapter1](chapter1) | Responses API demos：上下文与 Store、请求取消、结构化输出、流式响应、Function Calling |
| [chapter3](chapter3) | 基础 ReAct Agent Loop：SSE、客户端对话历史、天气工具、CLI |
| [chapter4](chapter4) | 本地文件读写与编辑、终端命令、文件搜索 |
| [chapter5](chapter5) | MCP client/server、工具发现、命名空间和 stdio/in-memory transport |
| [chapter6](chapter6) | Skills 加载、按需返回技能指令、可组合的 Responses request builder |
| [chapter7](chapter7) | SQLite session 持久化、workspace 恢复、多轮历史和会话命令 |
| [chapter8](chapter8) | Markdown slash commands、位置参数和 prompt 模板展开 |
| [chapter9](chapter9) | Chapter 8 当前实现的独立副本，作为后续章节的起点 |
| [chapter10](chapter10) | OpenTUI terminal frontend、Node agent server 和 stdio NDJSON protocol |

Chapter 2 尚未包含在当前 workspace 中。

## 快速开始

环境要求：Node.js `>=22.18`、pnpm `11`。

```bash
pnpm install
pnpm --filter @zero-agent/chapter8 start
```

不带 prompt 参数会进入交互模式。也可直接传入一次性 prompt：

```bash
pnpm --filter @zero-agent/chapter3 start "What's the weather like in Tokyo?"
```

API 凭据可通过环境变量提供，或放在运行 chapter 的目录下 `.env` 文件中：

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

`OPENAI_BASE_URL` 可指向兼容 Responses API 的服务；不同服务对 reasoning、Store 和工具调用等能力的支持可能不同。

## Chapter 8 示例

Chapter 8 的交互模式会加载当前 workspace 的 commands 和 skills，并管理持久化 session。用户命令文件放在 `~/.zeroagent/commands/` 或 `<workdir>/.zeroagent/commands/`，格式为带 `name`、`description` frontmatter 的 Markdown 文件：

```markdown
---
name: review
description: Review a file or diff
---
Review this file: $1
Focus on: ${2:-correctness, style, and performance}
```

交互模式支持 `/review <file>`、`/sessions`、`/resume <id>`、`/clear` 和 `/reload`。详见 [chapter8/README.md](chapter8/README.md)。

## 验证

每个 chapter 都有独立的 typecheck 和测试脚本，可按需运行：

```bash
pnpm --filter @zero-agent/chapter3 typecheck
pnpm --filter @zero-agent/chapter3 test
pnpm --filter @zero-agent/chapter8 typecheck
pnpm --filter @zero-agent/chapter8 test
```

测试使用 mock fetch/SSE 和临时目录，不需要真实 API 凭据。`chapter1` 是独立能力 demos，其运行方式见 [chapter1/README.md](chapter1/README.md)。
