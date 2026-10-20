## ADDED Requirements

### Requirement: SQLite database initialization
The `SessionStore` SHALL initialize a SQLite database at `~/.zeroagent/sessions.db` using Node's built-in `node:sqlite` module. The store SHALL create the `~/.zeroagent/` directory recursively if it does not exist, then open or create the database file.

#### Scenario: Database file is created on first use
- **WHEN** `SessionStore` is instantiated and `~/.zeroagent/sessions.db` does not exist
- **THEN** the store SHALL create the `~/.zeroagent/` directory, create the database file, and open a connection

#### Scenario: Existing database is reused
- **WHEN** `SessionStore` is instantiated and `~/.zeroagent/sessions.db` already exists
- **THEN** the store SHALL open the existing database file without recreating it

### Requirement: Schema migration
The `SessionStore` SHALL create the following schema if it does not exist, using `CREATE TABLE IF NOT EXISTS`:

```
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    model TEXT,
    workspace TEXT,
    parent_session_id TEXT REFERENCES sessions(id),
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace);
```

#### Scenario: Tables are created on first connection
- **WHEN** the database is newly created and schema migration runs
- **THEN** both `sessions` and `messages` tables SHALL exist with the exact column definitions specified, including the self-referencing FK on `sessions.parent_session_id` and the FK from `messages.session_id` to `sessions.id`

#### Scenario: Migration is idempotent
- **WHEN** `SessionStore` is instantiated against a database that already has the tables
- **THEN** no error SHALL be raised and existing data SHALL be preserved

### Requirement: Database connection lifecycle
The `SessionStore` SHALL provide a `close()` method that closes the underlying SQLite database connection. Once closed, the store SHALL NOT be used for further operations.

#### Scenario: Close releases the connection
- **WHEN** `store.close()` is called
- **THEN** the SQLite database connection SHALL be closed and subsequent operations SHALL throw an error

### Requirement: Session ID generation
The `SessionStore` SHALL generate session IDs as UUID v4 strings using `node:crypto.randomUUID()`.

#### Scenario: New session gets a UUID
- **WHEN** a new session is created
- **THEN** the session ID SHALL be a valid UUID v4 string

### Requirement: Message ID generation
The `SessionStore` SHALL generate message IDs as UUID v4 strings using `node:crypto.randomUUID()`.

#### Scenario: New message gets a UUID
- **WHEN** a new message is appended to a session
- **THEN** the message ID SHALL be a valid UUID v4 string

### Requirement: Session CRUD
The `SessionStore` SHALL provide methods to insert, query, and delete sessions:
- `insertSession(session)` — insert a new session row
- `getSessionById(id)` — return the session row or `undefined`
- `updateSessionTitle(id, title)` — update the title and `updated_at`
- `updateSessionTimestamp(id)` — refresh `updated_at` to now
- `deleteSession(id)` — delete a session and all its messages (cascade)

#### Scenario: Insert and retrieve a session
- **WHEN** a session is inserted with id, title, model, workspace, created_at, updated_at
- **THEN** `getSessionById(id)` SHALL return a row with all those fields

#### Scenario: Delete session cascades to messages
- **WHEN** a session with 5 messages is deleted
- **THEN** the session row and all 5 message rows SHALL be removed from the database

#### Scenario: Get non-existent session returns undefined
- **WHEN** `getSessionById` is called with a non-existent ID
- **THEN** it SHALL return `undefined`

### Requirement: Message CRUD
The `SessionStore` SHALL provide methods to insert and query messages:
- `insertMessage(message)` — insert a new message row
- `getMessagesBySessionId(sessionId)` — return all messages for a session, ordered by `created_at` ascending
- `getMessageCountBySessionId(sessionId)` — return the count of messages

#### Scenario: Messages are returned in creation order
- **WHEN** three messages are inserted in sequence and then retrieved
- **THEN** `getMessagesBySessionId` SHALL return them ordered by `created_at` ascending

#### Scenario: Get messages for non-existent session returns empty
- **WHEN** `getMessagesBySessionId` is called with a non-existent session ID
- **THEN** it SHALL return an empty array

### Requirement: Query sessions by workspace
The `SessionStore` SHALL provide `getSessionsByWorkspace(workspace)` that returns all sessions for a given workspace, ordered by `updated_at` descending.

#### Scenario: List workspace sessions newest first
- **WHEN** three sessions exist for workspace `/projects/foo` with different `updated_at` values
- **THEN** `getSessionsByWorkspace` SHALL return all three sorted by `updated_at` descending
