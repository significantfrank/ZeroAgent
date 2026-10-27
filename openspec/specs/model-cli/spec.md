# model-cli Specification

## Purpose
TBD - created by archiving change model-management. Update Purpose after archive.
## Requirements
### Requirement: Startup loads model config
When the CLI starts, it SHALL load `auth.json` and `models-config.json` and print a summary of loaded models. When no models are configured, it SHALL proceed without error.

#### Scenario: Models loaded and summarized
- **WHEN** the CLI starts with models configured
- **THEN** the CLI SHALL print a summary naming the loaded models

#### Scenario: No models configured
- **WHEN** the CLI starts with no `models-config.json`
- **THEN** the CLI SHALL start normally without printing model errors

### Requirement: List models command
The CLI SHALL support a `/models` command that lists all registered models, showing for each its id, provider, whether reasoning is enabled, available effort levels, and marking the active model.

#### Scenario: /models lists models with active marker
- **WHEN** the user types `/models` and at least one model is registered
- **THEN** the CLI SHALL list each model id with its provider, reasoning flag, and available levels, marking the active model

#### Scenario: /models with no models
- **WHEN** the user types `/models` and no models are registered
- **THEN** the CLI SHALL print a message indicating no models are configured

### Requirement: Switch model command
The CLI SHALL support a `/model <id>` command that switches the active model. Switching SHALL update the agent's active model and persist the new model to the active session.

#### Scenario: Switch to a known model
- **WHEN** the user types `/model deepseek-flash` and that model is registered
- **THEN** the agent's active model SHALL become `deepseek-flash` and the active session's stored model SHALL be updated to `deepseek-flash`

#### Scenario: Switch to an unknown model
- **WHEN** the user types `/model no-such-model` and that model is not registered
- **THEN** the CLI SHALL print an error naming the model and the active model SHALL remain unchanged

### Requirement: Reload command refreshes model config
The `/reload` command SHALL re-load `auth.json` and `models-config.json` in addition to commands, skills, and subagents.

#### Scenario: /reload reloads models
- **WHEN** the user types `/reload` after adding a new model to `models-config.json`
- **THEN** the new model SHALL be available to `/models` and `/model` without restarting the CLI

