# Chapter 8：Slash Commands

本章在 Chapter 7（Session 管理）基础上新增 **Slash Commands**：用户可在交互模式通过 `/命令名` 调用自己的可复用 prompt 模板，模板支持 bash 风格的占位符参数展开。

## Slash Commands

命令是带 YAML frontmatter 的 Markdown 文件。frontmatter 包含 `name`（命令名，调用时写作 `/name`）和 `description`（描述）；frontmatter 之后的正文是 prompt 模板。

```markdown
---
name: review
description: Review a file or diff
---
Review the following file and suggest improvements:

File: $1

Focus on: ${2:-correctness, style, and performance}
```

### 占位符

| 语法 | 含义 |
| --- | --- |
| `$1` `$2` … | 第 N 个位置参数；缺失时替换为空字符串 |
| `${N:-default}` | 第 N 个位置参数；缺失或为空时替换为 `default` |

展开分两遍进行：先 `${N:-default}`，再 `$N`，因此 default 值里可以再引用其他位置参数（如 `${1:-$2}`）。其余 shell 语法（`$@`、`${1-default}` 等）保持原样不解释。

### 加载路径

- 全局：`~/.zeroagent/commands/*.md`
- 项目级：`{workdir}/.zeroagent/commands/*.md`

项目级命令与全局命令同名时，项目级覆盖全局。交互模式启动时自动加载；运行中新增或修改命令文件后，用 `/reload` 重新加载 commands 与 skills。

### CLI 用法

| 命令 | 行为 |
| --- | --- |
| `/name arg1 arg2` | 空白切分参数，展开模板后作为 prompt 发给 agent |
| `/reload` | 重新加载 commands 与 skills 并打印数量 |
| 未知 `/foo` | 打印错误并列出可用命令 |

命令仅在交互模式生效；one-shot 模式（启动命令带 prompt）不加载也不解释命令。内置命令（`/sessions`、`/resume`、`/clear`、`/reload`）优先于用户命令。

## 存储架构（Chapter 7 遗留）

会话数据保存在 `~/.zeroagent/sessions.db`，使用 Node 内置的 `node:sqlite`，无需额外运行时依赖。

- `SessionStore`（`src/session/store.ts`）负责 SQLite 连接、schema 初始化和底层 CRUD。
- `SessionManager`（`src/session/manager.ts`）提供 `createSession`、`getSession`、`listSessions`、`appendMessage`、`getMessages`、`deleteSession` 和 `getLatestSessionByWorkspace` 等领域 API。

数据库包含两张表：

```sql
sessions(
	id PRIMARY KEY,
	title,
	model,
	workspace,
	parent_session_id REFERENCES sessions(id),
	created_at,
	updated_at
)

messages(
	id PRIMARY KEY,
	session_id REFERENCES sessions(id) ON DELETE CASCADE,
	role,
	content,
	created_at
)
```

## Agent 集成

通过 `AgentOptions.sessionManager` 和 `sessionId` 启用会话。Agent 会将已有消息历史加入模型请求，并把新的 user 消息和最终 assistant 回复写入数据库。没有同时提供这两个选项时，Agent 不读取或写入会话数据。

会话标题由第一条 user 消息自动生成，最长取 50 个字符；每次追加消息都会更新 session 的 `updated_at`，用于按最近活动排序。

## CLI 会话操作

交互模式启动时，CLI 查找当前 workspace 最近更新的 session；找到则恢复，否则创建新 session。One-shot 模式（启动命令带 prompt）不使用会话。

| 命令 | 行为 |
| --- | --- |
| `/sessions` | 列出当前 workspace 的会话及消息数、更新时间 |
| `/resume <id>` | 切换到指定 session |
| `/clear` | 创建并切换到新的 session |

workspace 默认为当前目录，也可通过 `ZEROAGENT_WORKDIR` 指定。

## 运行与测试

```bash
pnpm install
pnpm --dir chapter8 start
pnpm --dir chapter8 typecheck
pnpm --dir chapter8 test
```
