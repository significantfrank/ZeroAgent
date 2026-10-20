## Context

Chapter 7's `Agent` class (`agent-loop.ts`) builds each `stream()` call from scratch: a `PromptRequestBuilder` is constructed with a single developer message and a single user message, then tool calls/results are appended within that one run. The interactive REPL in `cli.ts` calls `agent.stream(prompt)` per turn — no history carries over. This means the agent has no memory between turns.

The conversation items (`InputItem` in `types.ts`) are already a well-defined union: `InputMessage | FunctionCallItem | FunctionCallOutputItem`. The `PromptRequestBuilder` already accepts arbitrary `InputItem[]` via `addInputItem()`. So the core integration is: feed accumulated messages from a session into the builder, and append new messages back to the session as they arrive.

The user wants SQLite-based persistence (not JSON files), with two tables (`sessions` and `messages`), stored at `~/.zeroagent/sessions.db`. Node ≥ 22.18 ships `node:sqlite` (experimental but functional). The agent should auto-load the workspace's most recent session on startup.

## Goals / Non-Goals

**Goals:**
- Persist conversation history in a SQLite embedded database at `~/.zeroagent/sessions.db`
- Two tables: `sessions` (id, title, model, workspace, parent_session_id, created_at, updated_at) and `messages` (id, session_id, role, content, created_at)
- Auto-load the workspace's latest session on CLI startup
- Resume, list, and clear sessions from the REPL
- Zero new dependencies (use `node:sqlite` built-in)
- Existing stateless behavior and tests remain untouched

**Non-Goals:**
- Remote or server-side session storage
- Session encryption or multi-user isolation
- Compaction/summarization of long sessions (future chapter)
- Session branching (parent_session_id is stored but branching UI is out of scope)
- Persisting raw tool_call / function_call_output items — only user/assistant text messages are stored (sufficient for session restore as conversation context)

## Decisions

### 1. SQLite via `node:sqlite` (not better-sqlite3, not JSON files)

**Rationale**: The project has zero runtime dependencies. Node ≥ 22.18 ships `node:sqlite` as a built-in experimental module — it works, it's fast, and it requires no `npm install`. SQLite gives us proper relational queries (JOIN, ORDER BY, FK cascade), atomic writes, and a single file for all workspaces.

**Alternatives considered**:
- `better-sqlite3`: adds a native dependency with build complexity
- JSON files per session: harder to query across sessions, no relational integrity
- In-memory only: defeats the purpose (resume after restart)

### 2. Database location: `~/.zeroagent/sessions.db`

**Rationale**: User-level directory shared across all workspaces. Sessions are scoped by the `workspace` column, so one DB file serves all projects. The `~/.zeroagent/` directory is already used for skills; sessions fit naturally alongside.

### 3. Two-table schema: `sessions` + `messages`

**Rationale**: Normalized design. `sessions` holds metadata (title, model, workspace, parent_session_id for future branching, timestamps). `messages` holds the conversation items as role/content pairs — simpler than storing raw `InputItem` JSON blobs, and sufficient for restoring conversation context (the agent sends `user`/`assistant` messages back to the API).

**Why not store function_call / function_call_output items?** The Responses API accepts `InputMessage` items (role + content) as conversation history. Tool calls within a single `stream()` run are already handled by the request builder's `addInputItem()`. Only cross-turn context (user prompts + assistant answers) needs to persist. This keeps the `messages` table simple and the session restore clean.

### 4. `SessionStore` (low-level) + `SessionManager` (high-level)

**Rationale**: Separation of concerns. `SessionStore` owns the `DatabaseSync` connection, schema migration, and raw SQL. `SessionManager` wraps it with domain methods (`createSession`, `getLatestSessionByWorkspace`, `appendMessage` with auto-title) that the agent and CLI consume. This makes the store testable in isolation and the manager easy to mock.

### 5. Session ID and Message ID: UUID v4

**Rationale**: `node:crypto.randomUUID()` is built-in, globally unique, and doesn't require a counter or coordination. IDs are 36-char strings — fine for SQLite TEXT primary keys.

### 6. Agent integration: optional `sessionManager` + `sessionId` on `AgentOptions`

**Rationale**: Making these optional means existing code (tests, one-shot mode) that doesn't pass them gets identical behavior. The agent checks at the top of `stream()`: if both are present, it loads messages from the DB, seeds the builder, and appends new messages after each turn.

**Key change in `agent-loop.ts`**:
- With session: load `manager.getMessages(sessionId)` → seed builder with those messages as `InputMessage` items → `manager.appendMessage(sessionId, 'user', input)` before building request → after run: `manager.appendMessage(sessionId, 'assistant', text)`
- Without session: `requestBuilder.addUserMsg(input)` (current behavior, unchanged)

### 7. CLI auto-load on startup

**Rationale**: When the CLI starts in interactive mode, it calls `manager.getLatestSessionByWorkspace(workdir)`. If found → use that session ID. If not → `manager.createSession(workdir, model)` → use new session ID. This gives a seamless "continue where I left off" experience.

### 8. `InputMessage.role` already includes `'assistant'`

**Rationale**: `types.ts` defines `role: 'user' | 'assistant' | 'developer' | 'system'` — no type changes needed. Session messages map directly to `InputMessage` objects.

## Risks / Trade-offs

- **`node:sqlite` is experimental**: The API may change in future Node versions. → *Mitigation*: The `SessionStore` class encapsulates all SQLite access; if the API changes, only one file needs updating. The experimental warning is cosmetic.
- **Tool calls are not persisted**: Only user/assistant text messages are stored. If a session is resumed, the model won't see prior tool calls/results. → *Mitigation*: For the tutorial scope, this is acceptable — the conversation context (what was asked and answered) is preserved. Full tool call persistence is a future enhancement.
- **Large sessions grow request size**: Every turn re-sends the full message history. → *Mitigation*: Acceptable for a tutorial; compaction is a future chapter.
- **Concurrent access from multiple CLI processes**: SQLite handles concurrent reads, but concurrent writes to the same session could conflict. → *Mitigation*: One session per CLI process is the expected usage. SQLite's default journal mode is sufficient.
- **`store: false` on Responses API**: The agent sets `setStore(false)` — it doesn't rely on OpenAI's server-side conversation state. Our session DB is the only history source. This is correct and intentional.
