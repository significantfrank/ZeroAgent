## 1. Session types and store (low-level SQLite)

- [x] 1.1 Create `chapter7/src/session/types.ts` — define `SessionRow` (id, title, model, workspace, parentSessionId, createdAt, updatedAt), `MessageRow` (id, sessionId, role, content, createdAt), `SessionMeta` (SessionRow + messageCount)
- [x] 1.2 Create `chapter7/src/session/store.ts` — `SessionStore` class: constructor opens `~/.zeroagent/sessions.db` via `node:sqlite DatabaseSync`, creates `~/.zeroagent/` dir recursively if missing
- [x] 1.3 Implement schema migration in `SessionStore` — `CREATE TABLE IF NOT EXISTS sessions(...)` and `messages(...)` with FK constraints + indexes (`idx_messages_session_id`, `idx_sessions_workspace`), idempotent
- [x] 1.4 Implement `SessionStore` session CRUD: `insertSession`, `getSessionById`, `updateSessionTitle`, `updateSessionTimestamp`, `deleteSession` (cascade delete messages), `getSessionsByWorkspace`
- [x] 1.5 Implement `SessionStore` message CRUD: `insertMessage`, `getMessagesBySessionId` (ordered by created_at ASC), `getMessageCountBySessionId`
- [x] 1.6 Implement `SessionStore.close()` — close the `DatabaseSync` connection
- [x] 1.7 Use `node:crypto.randomUUID()` for all session and message IDs

## 2. Session manager (high-level API)

- [x] 2.1 Create `chapter7/src/session/manager.ts` — `SessionManager` class wrapping `SessionStore`
- [x] 2.2 Implement `createSession(workspace, model?)` — insert session with UUID, empty title, current ISO timestamps, return `SessionRow`
- [x] 2.3 Implement `getSession(id)` — return `SessionMeta` (session row + messageCount) or `undefined`
- [x] 2.4 Implement `listSessions(workspace?)` — return `SessionMeta[]` sorted by `updatedAt` DESC; filter by workspace when provided
- [x] 2.5 Implement `deleteSession(id)` — delegate to store, return `true`/`false`
- [x] 2.6 Implement `appendMessage(sessionId, role, content)` — insert message with UUID + ISO timestamp, refresh session `updated_at`, auto-set title from first user message (first 50 chars) if title empty, return `MessageRow`
- [x] 2.7 Implement `getMessages(sessionId)` — return `MessageRow[]` ordered by `createdAt` ASC
- [x] 2.8 Implement `getLatestSessionByWorkspace(workspace)` — return `SessionRow | undefined` (most recent by `updated_at`)
- [x] 2.9 Create `chapter7/src/session/index.ts` barrel export

## 3. Agent loop integration

- [x] 3.1 Add `sessionManager?: SessionManager` and `sessionId?: string` to `AgentOptions` in `chapter7/src/types.ts`
- [x] 3.2 Modify `Agent` constructor to store `sessionManager` and `sessionId` from options
- [x] 3.3 Modify `Agent.stream()` — when session is active: load `manager.getMessages(sessionId)`, seed `PromptRequestBuilder` with those messages as `InputMessage` items before the new user message
- [x] 3.4 Modify `Agent.stream()` — when session is active: `manager.appendMessage(sessionId, 'user', input)` before building the first request
- [x] 3.5 Modify `Agent.stream()` — when session is active: after run completes (RunEnd event), `manager.appendMessage(sessionId, 'assistant', finalText)`
- [x] 3.6 Ensure stateless mode (no sessionManager) behaves exactly as before — no behavior change when omitted

## 4. CLI session commands

- [x] 4.1 Modify `chapter7/src/cli.ts` — instantiate `SessionManager` on startup (shared across REPL turns)
- [x] 4.2 Implement auto-load: in interactive mode, call `manager.getLatestSessionByWorkspace(workdir)`; if found use it, else `manager.createSession(workdir, model)`; print active session ID
- [x] 4.3 Pass `sessionManager` and `sessionId` to `Agent` constructor so all turns use the active session
- [x] 4.4 Implement `/sessions` command — list sessions for current workspace (ID, title, message count, updatedAt), newest first; print "No sessions found." if empty
- [x] 4.5 Implement `/resume <id>` command — load session by ID, set as active, print confirmation; print error if not found
- [x] 4.6 Implement `/clear` command — create new session for workspace, set as active, print new session ID
- [x] 4.7 Ensure one-shot mode (CLI args) does NOT create or use a session — remains stateless

## 5. Tests

- [x] 5.1 Create `chapter7/test/session.test.ts` — test `SessionStore`: DB init, schema creation, idempotent migration, close
- [x] 5.2 Test `SessionStore` session CRUD: insert, getById, updateTitle, updateTimestamp, delete (cascade), getByWorkspace (sorted desc), getNonExistent returns undefined
- [x] 5.3 Test `SessionStore` message CRUD: insert, getBySessionId (ordered ASC), getCount, empty for non-existent session
- [x] 5.4 Test `SessionManager`: createSession, appendMessage (with auto-title from first user msg), getMessages, getLatestSessionByWorkspace, listSessions (with/without workspace filter), deleteSession
- [x] 5.5 Test agent with session: multi-turn conversation — second request includes first user + first assistant message from DB history
- [x] 5.6 Test agent without session: existing tests remain green (no regression)
- [x] 5.7 Run `pnpm --filter @zero-agent/chapter7 test` and `pnpm --filter @zero-agent/chapter7 typecheck` — all pass

## 6. Documentation

- [x] 6.1 Update `chapter7/README.md` — document session management feature, SQLite DB location, table schema, CLI commands, and auto-load behavior
