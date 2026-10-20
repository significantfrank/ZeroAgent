## Why

Chapter 7's agent currently lives in a single conversation turn — each `stream()` call builds a fresh `PromptRequestBuilder` that only contains the initial developer + user messages and whatever tool calls/results accumulated during that one run. When the interactive REPL loops to the next prompt, **all prior conversation context is lost**: the agent has no memory of what was said in previous turns. This makes multi-turn conversations impossible and forces the user to repeat context every time.

Session management is the foundational capability that makes the agent actually usable for real work: persisting conversation history to a SQLite embedded database, resuming sessions after restart, and automatically loading the workspace's most recent session on startup.

## What Changes

- Add a `SessionStore` that manages a SQLite database at `~/.zeroagent/sessions.db` using Node's built-in `node:sqlite` module — zero new dependencies
- Two tables: `sessions` (id, title, model, workspace, parent_session_id, created_at, updated_at) and `messages` (id, session_id, role, content, created_at) with FK → sessions.id
- Add a `SessionManager` that provides `createSession()`, `getSession()`, `listSessions()`, `appendMessage()`, `getMessages()`, `deleteSession()` — the high-level API the agent and CLI use
- Modify `Agent` to accept an optional `SessionManager` + active session ID — when provided, the agent appends user/assistant/tool messages to the DB and feeds full conversation history into the request builder
- Add CLI commands: `/sessions` (list), `/resume <id>` (resume a session), `/clear` (start fresh)
- When the CLI starts in interactive mode, it SHALL automatically load the workspace's most recent session (or create a new one if none exists)
- **BREAKING**: `AgentOptions` gains optional `sessionManager?: SessionManager` and `sessionId?: string` fields — omitting them preserves current stateless behavior

## Capabilities

### New Capabilities
- `session-store`: SQLite-based persistence — `SessionStore` manages the database connection, schema migration, and low-level CRUD on `sessions` and `messages` tables
- `session-manager`: High-level session management — `SessionManager` wraps `SessionStore` to provide `createSession`, `getSession`, `listSessions`, `appendMessage`, `getMessages`, `deleteSession`, and `getLatestSessionByWorkspace`
- `session-aware-agent`: Agent loop integration — the agent uses session history to build requests and appends new messages after each step
- `session-cli`: CLI commands for session management — auto-load on startup, list, resume, clear

### Modified Capabilities
<!-- none — this is a new feature, no existing specs to modify -->

## Impact

- **New files**: `chapter7/src/session/types.ts`, `chapter7/src/session/store.ts`, `chapter7/src/session/manager.ts`, `chapter7/src/session/index.ts`
- **Modified files**: `chapter7/src/agent-loop.ts` (accept SessionManager, use history), `chapter7/src/cli.ts` (auto-load, session commands), `chapter7/src/types.ts` (AgentOptions gains sessionManager/sessionId)
- **No new dependencies**: uses only `node:sqlite` (Node ≥ 22.18 built-in, experimental but stable enough for this use case) + `node:crypto` + `node:path` + `node:os`
- **Database location**: `~/.zeroagent/sessions.db` (single file, shared across all workspaces; sessions are scoped by `workspace` column)
- **Tests**: new `chapter7/test/session.test.ts`; existing tests remain green (stateless mode is the default)
- **No breaking changes to existing API surface** — `sessionManager` and `sessionId` are optional
