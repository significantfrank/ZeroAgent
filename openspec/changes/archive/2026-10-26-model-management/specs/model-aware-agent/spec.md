## ADDED Requirements

### Requirement: Agent resolves model to provider client
When the agent's active model is registered in the model registry, the agent SHALL send requests to that model's provider baseUrl with that provider's key. When the model is not registered, the agent SHALL fall back to the env-configured client (`OPENAI_BASE_URL` / `OPENAI_API_KEY`).

#### Scenario: Registered model uses provider endpoint
- **WHEN** the active model is `deepseek-flash` and its provider `deepseek` has baseUrl `https://api.deepseek.com/v1`
- **THEN** requests SHALL be sent to `https://api.deepseek.com/v1` using the provider key

#### Scenario: Unregistered model uses env client
- **WHEN** the active model is `gpt-4o-mini` and it is not in the registry
- **THEN** requests SHALL be sent using `OPENAI_BASE_URL` and `OPENAI_API_KEY` from the environment

### Requirement: Switchable active model
The agent SHALL allow its active model to be changed after construction, and subsequent `stream()` calls SHALL use the new model.

#### Scenario: Model switch takes effect
- **WHEN** the agent's model is changed from `deepseek-flash` to `glm-5.3`
- **THEN** the next `stream()` call SHALL build its request with model `glm-5.3`

### Requirement: reasoning gated by model config
When the active model has `reasoning: false` or no `reasoning` field, the request SHALL NOT include a `reasoning` field. When `reasoning: true`, the request SHALL include `reasoning`.

#### Scenario: reasoning disabled omits field
- **WHEN** the active model has `reasoning: false`
- **THEN** the built request SHALL NOT contain a `reasoning` field

#### Scenario: reasoning enabled includes field
- **WHEN** the active model has `reasoning: true`
- **THEN** the built request SHALL contain a `reasoning` field

### Requirement: reasoning effort translated through level map
When the active model has a `thinkingLevelMap`, the agent SHALL translate the requested effort level (`high` by default) using the map: if the map value is a non-null string, that string SHALL be sent as `reasoning.effort`; if it is `null`, the agent SHALL fall back to the highest available level not above `high`, or the lowest available level when none is below `high`.

#### Scenario: Direct translation
- **WHEN** the model's map has `high: "high"` and effort `high` is requested
- **THEN** the request SHALL send `reasoning.effort = "high"`

#### Scenario: Provider-specific translation
- **WHEN** the model's map has `high: "xhigh"` and effort `high` is requested
- **THEN** the request SHALL send `reasoning.effort = "xhigh"`

#### Scenario: Requested level is null, fall back down
- **WHEN** the map has `low: "low"`, `max: "max"`, and `high: null`, and effort `high` is requested
- **THEN** the request SHALL send `reasoning.effort = "low"` (highest available not above `high`)

#### Scenario: Requested level is null, fall back up
- **WHEN** the map has only `max: "max"` available and effort `high` is requested
- **THEN** the request SHALL send `reasoning.effort = "max"` (lowest available)

### Requirement: Model without level map sends canonical effort
When the active model has `reasoning: true` but no `thinkingLevelMap`, the request SHALL send the canonical `reasoning.effort` (`high`) unchanged.

#### Scenario: No map uses canonical effort
- **WHEN** the model has `reasoning: true` and no `thinkingLevelMap`
- **THEN** the request SHALL send `reasoning.effort = "high"`

### Requirement: maxTokens maps to max_output_tokens
When the active model has `maxTokens`, the agent SHALL include it as `max_output_tokens` in the request.

#### Scenario: maxTokens is forwarded
- **WHEN** the model has `maxTokens: 384000`
- **THEN** the request SHALL include `max_output_tokens: 384000`

### Requirement: Subagent model override is validated
When a subagent definition specifies a `model`, the agent SHALL resolve it against the registry; if the model id is unknown, the subagent invocation SHALL fail with an error naming the model. A known model id SHALL be used for the subagent's requests.

#### Scenario: Unknown subagent model fails
- **WHEN** a subagent definition has `model: "no-such-model"` which is not in the registry
- **THEN** invoking the subagent SHALL fail with an error naming `no-such-model`

#### Scenario: Known subagent model is used
- **WHEN** a subagent definition has `model: "deepseek-flash"` which is in the registry
- **THEN** the subagent's requests SHALL use model `deepseek-flash`
