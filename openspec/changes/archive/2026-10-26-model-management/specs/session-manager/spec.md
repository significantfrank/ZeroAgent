## ADDED Requirements

### Requirement: setSessionModel updates a session's model
The `SessionManager` SHALL provide `setSessionModel(id, model)` that updates the stored model for the session.

#### Scenario: Active session model is updated
- **WHEN** `setSessionModel(id, 'deepseek-flash')` is called for an existing session
- **THEN** the session's stored model SHALL be `'deepseek-flash'`
