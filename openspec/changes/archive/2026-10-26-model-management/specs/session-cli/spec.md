## MODIFIED Requirements

### Requirement: Resume session command
The CLI SHALL support a `/resume <id>` command that loads a past session by ID, makes it the active session, and restores the session's stored model as the agent's active model.

#### Scenario: Resume an existing session
- **WHEN** the user types `/resume <valid-id>` and that session exists with a stored model
- **THEN** the CLI SHALL set it as the active session, restore the stored model to the agent, and print a confirmation with the session ID, title, message count, and model

#### Scenario: Resume a session without a stored model
- **WHEN** the user types `/resume <valid-id>` and that session exists but has an empty `model`
- **THEN** the CLI SHALL set it as the active session and leave the agent's current model unchanged

#### Scenario: Resume a non-existent session
- **WHEN** the user types `/resume nonexistent_id` and that session does not exist
- **THEN** the CLI SHALL print an error "Session not found: nonexistent_id" and the current active session SHALL remain unchanged
