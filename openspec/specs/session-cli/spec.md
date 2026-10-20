# session-cli Specification

## Purpose
TBD - created by archiving change session-management. Update Purpose after archive.
## Requirements
### Requirement: Auto-load workspace's latest session on startup
When the CLI starts in interactive mode, it SHALL query `SessionManager.getLatestSessionByWorkspace(workdir)`. If a session is found, it SHALL be used as the active session. If no session is found, a new session SHALL be created for that workspace.

#### Scenario: Existing session is loaded on startup
- **WHEN** the CLI starts in interactive mode and a session for the current workspace exists in the database
- **THEN** that session SHALL be loaded as the active session and its ID SHALL be displayed to the user

#### Scenario: New session is created when none exists
- **WHEN** the CLI starts in interactive mode and no session for the current workspace exists
- **THEN** a new session SHALL be created for the workspace and its ID SHALL be displayed

### Requirement: Interactive REPL uses sessions by default
The CLI's interactive REPL SHALL pass the active session manager and session ID to the agent for all turns, so that conversation context persists across turns.

#### Scenario: Second turn has context from first turn
- **WHEN** the user sends a first prompt "My name is Frank" and then a second prompt "What is my name?"
- **THEN** the agent SHALL respond using the context from the first turn, demonstrating that the session history was included in the second request

### Requirement: List sessions command
The CLI SHALL support a `/sessions` command that lists all sessions for the current workspace, showing ID, title, message count, and last-updated timestamp, sorted newest first.

#### Scenario: /sessions shows available sessions
- **WHEN** the user types `/sessions` in the REPL and at least one session exists for the workspace
- **THEN** the CLI SHALL print a table of sessions showing ID, title, message count, and updatedAt, sorted newest first

#### Scenario: /sessions with no sessions
- **WHEN** the user types `/sessions` and no sessions exist for the workspace
- **THEN** the CLI SHALL print "No sessions found."

### Requirement: Resume session command
The CLI SHALL support a `/resume <id>` command that loads a past session by ID and makes it the active session for subsequent turns.

#### Scenario: Resume an existing session
- **WHEN** the user types `/resume <valid-id>` and that session exists
- **THEN** the CLI SHALL set it as the active session and print a confirmation with the session ID, title, and message count

#### Scenario: Resume a non-existent session
- **WHEN** the user types `/resume nonexistent_id` and that session does not exist
- **THEN** the CLI SHALL print an error "Session not found: nonexistent_id" and the current active session SHALL remain unchanged

### Requirement: Clear session command
The CLI SHALL support a `/clear` command that creates a fresh session for the current workspace and makes it the active session, so the user can start a new conversation without restarting the CLI.

#### Scenario: Clear creates a new session
- **WHEN** the user types `/clear` during an active REPL session
- **THEN** the CLI SHALL create a new session, set it as active, print the new session ID, and subsequent turns SHALL NOT include history from the previous session

### Requirement: One-shot mode does not use sessions
When the CLI is invoked with prompt arguments (non-interactive mode), it SHALL NOT create or use a session — the behavior SHALL remain stateless as before.

#### Scenario: One-shot mode is stateless
- **WHEN** the CLI is invoked as `pnpm start "What is the weather?"`
- **THEN** no session SHALL be created or loaded and the agent SHALL run in stateless mode

