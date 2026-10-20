# Chapter 7：Session 管理

本章在 Agent Loop 中加入持久化会话：交互模式可按 workspace 恢复历史对话、切换会话或新建会话；不启用会话时，Agent 仍可无状态运行。

## 存储架构

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
pnpm --dir chapter7 start
pnpm --dir chapter7 typecheck
pnpm --dir chapter7 test
```
