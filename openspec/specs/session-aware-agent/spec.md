# session-aware-agent Specification

## Purpose
TBD - created by archiving change session-management. Update Purpose after archive.
## Requirements
### Requirement: Agent accepts optional session manager
The `Agent` SHALL accept optional `sessionManager?: SessionManager` and `sessionId?: string` via `AgentOptions`. When both are provided, the agent SHALL load the session's messages as conversation history and append new messages as they are produced.

#### Scenario: Stateless mode when no session manager is provided
- **WHEN** `stream()` is called without `sessionManager` in options
- **THEN** the agent SHALL behave exactly as before — building a fresh request with only the initial developer + user messages for this call

#### Scenario: Session mode uses accumulated history
- **WHEN** `stream()` is called with a `sessionManager` and `sessionId` for a session that already contains prior messages
- **THEN** the request builder SHALL include all prior messages from the session history before the new user message

### Requirement: Append user message to session
When session management is active, the agent SHALL append the user's input as a `user` role message to the session before building the first request of that `stream()` call.

#### Scenario: User message is persisted
- **WHEN** the user sends "What is the weather?" and session management is active
- **THEN** a message with role `user` and content "What is the weather?" SHALL be inserted into the database for the active session

### Requirement: Append assistant response to session
When session management is active, after the agent produces a final answer or text response, the agent SHALL append an `assistant` role message with the response text to the session.

#### Scenario: Final answer is persisted
- **WHEN** the agent produces a final answer "Tokyo is cloudy."
- **THEN** a message with role `assistant` and content "Tokyo is cloudy." SHALL be inserted into the database for the active session

### Requirement: Session history feeds into request builder
The request builder SHALL be initialized with the session's accumulated messages (user, assistant, developer roles) at the start of each `stream()` call, so that the model sees the full conversation context.

#### Scenario: Multi-turn conversation maintains context
- **WHEN** the user sends a second prompt "What about London?" in the same session
- **THEN** the request to the API SHALL include the first user message, the first assistant response, and the second user message — demonstrating full conversation history is sent

### Requirement: Session updated timestamp is refreshed
When session management is active, the session's `updated_at` SHALL be refreshed after each `stream()` call completes (whether successfully or with error), so that `getLatestSessionByWorkspace` reflects the most recently active session.

#### Scenario: Updated_at changes after a turn
- **WHEN** the agent completes a `stream()` call with session management active
- **THEN** the session's `updated_at` in the database SHALL be more recent than before the call

