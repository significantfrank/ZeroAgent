## 1. Model registry module

- [x] 1.1 Add `chapter10/src/model/types.ts` with `ProviderAuth`, `ThinkingLevelMap`, and `ModelDefinition` types
- [x] 1.2 Add `chapter10/src/model/loader.ts` with `loadAuth` and `loadModels` using hand-rolled JSON validation (reject invalid field types, unknown provider references, and bad `thinkingLevelMap` keys/values)
- [x] 1.3 Add `chapter10/src/model/registry.ts` with `ModelRegistry` (`register`, `get`, `list`, `names`, `resolveAuth`, `availableEfforts`, `clear`)
- [x] 1.4 Add `chapter10/src/model/index.ts` re-exporting the module's public API
- [x] 1.5 Add `chapter10/test/model.test.ts` covering every scenario in the `model-registry` spec

## 2. Model-aware client routing

- [x] 2.1 Extend `ResponsesClient` with an optional `resolveProvider` option and a per-provider `OpenAI` client cache, resolving `request.model` on `stream()`
- [x] 2.2 Add client tests for env fallback and provider routing using mocked fetch

## 3. Agent model awareness

- [x] 3.1 Add `max_output_tokens` to `ResponsesRequest` and `setMaxOutputTokens` to `PromptRequestBuilder`
- [x] 3.2 Accept the model registry/definition resolver in the agent and add a `setModel` method for a switchable active model
- [x] 3.3 Implement reasoning gating and `thinkingLevelMap` translation (fixed effort `high`, fallback rule) when building requests
- [x] 3.4 Forward the model's `maxTokens` as `max_output_tokens`
- [x] 3.5 Validate subagent `model:` overrides at invocation, failing on unknown model ids
- [x] 3.6 Add agent tests covering every scenario in the `model-aware-agent` spec

## 4. Session model persistence

- [x] 4.1 Add `SessionStore.updateSessionModel(id, model)`
- [x] 4.2 Add `SessionManager.setSessionModel(id, model)`
- [x] 4.3 Extend `chapter10/test/session.test.ts` for the `session-store` and `session-manager` model-update scenarios

## 5. CLI wiring

- [x] 5.1 Load the model registry at startup, construct `ResponsesClient` with `resolveProvider`, and print a loaded-model summary
- [x] 5.2 Add the `/models` command
- [x] 5.3 Add the `/model <id>` command (switch active model and persist via `setSessionModel`)
- [x] 5.4 Extend `/reload` to also reload `auth.json` and `models-config.json`
- [x] 5.5 Extend `/resume` to restore the session's stored model to the agent
- [x] 5.6 Add CLI/command tests for `/models`, `/model`, and `/resume` model restoration

## 6. Docs and verification

- [x] 6.1 Rewrite `chapter10/README.md` to document model management (auth.json, models-config.json, `/models`, `/model`)
- [x] 6.2 Update the root `README.md` chapter10 row and quick-start section
- [x] 6.3 Ensure `auth.json` is gitignored and never committed
- [x] 6.4 Run `pnpm --filter @zero-agent/chapter10 typecheck` and `pnpm --filter @zero-agent/chapter10 test` and fix any failures
