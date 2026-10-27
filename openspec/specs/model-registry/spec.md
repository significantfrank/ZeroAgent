# model-registry Specification

## Purpose
TBD - created by archiving change model-management. Update Purpose after archive.
## Requirements
### Requirement: Load provider auth
The model registry SHALL load provider credentials from `~/.zeroagent/auth.json`, where each key is a provider name and the value is `{ baseUrl, type, key }`. A missing file SHALL produce an empty provider set rather than an error.

#### Scenario: Valid auth file is loaded
- **WHEN** `auth.json` exists with a provider `deepseek` whose value is `{ "baseUrl": "...", "type": "api_key", "key": "..." }`
- **THEN** the registry SHALL expose provider `deepseek` with that baseUrl and key

#### Scenario: Missing auth file yields empty providers
- **WHEN** `~/.zeroagent/auth.json` does not exist
- **THEN** loading SHALL succeed and the registry SHALL have no providers

### Requirement: Load model definitions
The model registry SHALL load model definitions from `~/.zeroagent/models-config.json`, where each key is a model id and the value is `{ provider, name?, reasoning?, thinkingLevelMap?, maxTokens? }`. A missing file SHALL produce an empty model set rather than an error.

#### Scenario: Valid models file is loaded
- **WHEN** `models-config.json` exists with key `deepseek-flash` whose value has `provider: "deepseek"`, `reasoning: true`, and a `thinkingLevelMap`
- **THEN** the registry SHALL expose model `deepseek-flash` with those fields

#### Scenario: Missing models file yields empty models
- **WHEN** `~/.zeroagent/models-config.json` does not exist
- **THEN** loading SHALL succeed and the registry SHALL have no models

### Requirement: Validate model fields
The loader SHALL reject invalid model entries with an error naming the file and field. `provider` MUST be a non-empty string; `reasoning`, when present, MUST be a boolean; `maxTokens`, when present, MUST be a positive number; `name`, when present, MUST be a non-empty string.

#### Scenario: Invalid reasoning type is rejected
- **WHEN** a model entry has `reasoning: "yes"` (a string)
- **THEN** loading SHALL throw an error naming the file and the `reasoning` field

#### Scenario: Missing provider is rejected
- **WHEN** a model entry has no `provider` field
- **THEN** loading SHALL throw an error naming the file and the `provider` field

### Requirement: Validate provider references
Every model's `provider` MUST match a key in the loaded auth providers. A model whose provider has no auth entry SHALL be rejected.

#### Scenario: Unknown provider is rejected
- **WHEN** a model entry references provider `glm` but `auth.json` has no `glm` entry
- **THEN** loading SHALL throw an error naming the model and provider

### Requirement: Validate thinking level map
When `thinkingLevelMap` is present, its keys MUST be a subset of `minimal`, `low`, `medium`, `high`, `max`, and each value MUST be either a non-empty string or `null`.

#### Scenario: Unknown level key is rejected
- **WHEN** a `thinkingLevelMap` contains key `xhigh`
- **THEN** loading SHALL throw an error naming the invalid key

#### Scenario: Non-string non-null value is rejected
- **WHEN** a `thinkingLevelMap` contains `{ "high": 5 }`
- **THEN** loading SHALL throw an error naming the invalid value

### Requirement: Resolve model to provider credentials
The registry SHALL provide a method to resolve a model id to its provider's `{ baseUrl, key }`, returning `undefined` when the model or its provider is unknown.

#### Scenario: Resolve a known model
- **WHEN** resolving model `deepseek-flash` whose provider `deepseek` has a loaded auth entry
- **THEN** the method SHALL return `{ baseUrl, key }` from the `deepseek` auth entry

#### Scenario: Resolve an unknown model
- **WHEN** resolving a model id that is not in the registry
- **THEN** the method SHALL return `undefined`

### Requirement: List available reasoning effort levels
The registry SHALL expose the set of effort levels whose `thinkingLevelMap` value is non-null for a model, returning `undefined` when the model has no `thinkingLevelMap`.

#### Scenario: Available levels from a map
- **WHEN** a model's `thinkingLevelMap` maps `low` and `high` to strings and `minimal`, `medium`, `max` to `null`
- **THEN** the available levels SHALL be `["low", "high"]` in canonical order

#### Scenario: No map yields undefined
- **WHEN** a model has no `thinkingLevelMap`
- **THEN** the available levels SHALL be `undefined`

