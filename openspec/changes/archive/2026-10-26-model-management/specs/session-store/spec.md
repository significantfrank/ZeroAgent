## ADDED Requirements

### Requirement: Update session model
The `SessionStore` SHALL provide `updateSessionModel(id, model)` that updates the session's `model` column and refreshes `updated_at` to now.

#### Scenario: Session model is updated
- **WHEN** `updateSessionModel(id, 'glm-5.3')` is called for an existing session
- **THEN** the session's `model` SHALL become `'glm-5.3'` and its `updated_at` SHALL be refreshed
