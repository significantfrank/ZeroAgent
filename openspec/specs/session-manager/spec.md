# session-manager Specification

## Purpose
TBD - created by archiving change session-management. Update Purpose after archive.
## Requirements
### Requirement: SessionManager provides high-level API
The `SessionManager` SHALL wrap `SessionStore` to provide a domain-friendly API: `createSession(workspace, model?)`, `getSession(id)`, `listSessions(workspace?)`, `deleteSession(id)`, `appendMessage(sessionId, role, content)`, `getMessages(sessionId)`, and `getLatestSessionByWorkspace(workspace)`.

#### Scenario: createSession returns a session object
- **WHEN** `createSession('/projects/foo', 'gpt-4o-mini')` is called
- **THEN** a session row SHALL be inserted with the given workspace and model, a generated UUID, empty title, current ISO timestamps, and the created session SHALL be returned

#### Scenario: appendMessage persists and returns the message
- **WHEN** `appendMessage(sessionId, 'user', 'Hello')` is called
- **THEN** a message row SHALL be inserted with the given sessionId, role, content, a generated UUID, current ISO timestamp, the session's `updated_at` SHALL be refreshed, and the created message SHALL be returned

### Requirement: getLatestSessionByWorkspace
The `SessionManager` SHALL provide `getLatestSessionByWorkspace(workspace)` that returns the most recently updated session for the given workspace, or `undefined` if none exists.

#### Scenario: Returns the most recent session
- **WHEN** three sessions exist for workspace `/projects/foo` with different `updated_at` values
- **THEN** `getLatestSessionByWorkspace` SHALL return the session with the latest `updated_at`

#### Scenario: Returns undefined when no sessions exist
- **WHEN** no sessions exist for the given workspace
- **THEN** `getLatestSessionByWorkspace` SHALL return `undefined`

### Requirement: getMessages returns conversation history
The `SessionManager.getMessages(sessionId)` SHALL return all messages for the session as an array of `{ id, sessionId, role, content, createdAt }` objects, ordered by `created_at` ascending.

#### Scenario: Returns full conversation history
- **WHEN** a session has 5 messages (2 user, 2 assistant, 1 tool result)
- **THEN** `getMessages` SHALL return all 5 in creation order

### Requirement: listSessions returns metadata
The `SessionManager.listSessions(workspace?)` SHALL return an array of `{ id, title, model, workspace, createdAt, updatedAt, messageCount }` for each session. When `workspace` is provided, only sessions for that workspace are returned. Results are sorted by `updatedAt` descending.

#### Scenario: List all sessions across workspaces
- **WHEN** `listSessions()` is called without a workspace filter
- **THEN** all sessions SHALL be returned sorted by `updatedAt` descending, each with `messageCount`

#### Scenario: List sessions filtered by workspace
- **WHEN** `listSessions('/projects/foo')` is called
- **THEN** only sessions with `workspace = '/projects/foo'` SHALL be returned

### Requirement: deleteSession removes session and messages
The `SessionManager.deleteSession(id)` SHALL delete the session and all its messages from the database. Returns `true` if the session existed, `false` otherwise.

#### Scenario: Delete removes session and its messages
- **WHEN** a session with 3 messages is deleted
- **THEN** both the session row and all 3 message rows SHALL be removed

#### Scenario: Delete non-existent session returns false
- **WHEN** `deleteSession` is called with a non-existent ID
- **THEN** it SHALL return `false` without throwing

### Requirement: Session title auto-generation
The `SessionManager` SHALL set the session title to the first 50 characters of the first user message when the first message is appended, if the title is still empty.

#### Scenario: Title is set from first user message
- **WHEN** the first message with role `user` and content "What is the weather in Tokyo?" is appended to a session with empty title
- **THEN** the session's title SHALL be updated to "What is the weather in Tokyo?" (truncated to 50 chars if longer)

