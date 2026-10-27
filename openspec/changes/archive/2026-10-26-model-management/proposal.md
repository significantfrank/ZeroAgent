## Why

ZeroAgent 到目前为止把 model 当作一根裸字符串：它来自 `OPENAI_MODEL` env 或 subagent 文件里手写的字符串，没有 registry、没有 provider 鉴权、无法在 CLI 里切换，session 里存的 model 也从不生效。本章把 model 提升为一等公民——可配置、可列出、可切换、按 provider 鉴权，并让 session / subagent 闭环。

## What Changes

- 新增 `~/.zeroagent/auth.json`：provider → `{ baseUrl, type, key }`，作为鉴权与端点权威。
- 新增 `~/.zeroagent/models-config.json`：model id → `{ provider, name?, reasoning?, thinkingLevelMap?, maxTokens? }`。
- 新增 model registry 模块，负责加载、校验、查询 model 定义与 provider 鉴权。
- Agent 按 model 解析出 provider 的 baseUrl/key 构造请求；未配置的 model 回落到 env 直连（保留 `gpt-4o-mini` 等旧行为）。
- reasoning 由 model 配置门控：`reasoning: false` 不发 reasoning 字段；`thinkingLevelMap` 把规范档位翻译成 provider 值，且只落在可用档位。
- 新增 `/models`、`/model <id>` 命令；`/reload` 同时重载 model 配置。
- session 补齐 model 持久化：新增 `updateSessionModel` / `setSessionModel`，`/resume` 恢复 session 的 model。
- subagent 的 `model:` 统一为 models-config 的 key，调用时校验，未知报错。
- 更新 `chapter10/README.md` 与根 `README.md` 的 chapter10 行。

## Capabilities

### New Capabilities
- `model-registry`: auth.json 与 models-config.json 的加载、校验、查询。
- `model-aware-agent`: model→provider→client 解析、env 兜底、reasoning 门控与档位翻译、可切换 model、subagent model 校验。
- `model-cli`: `/models`、`/model` 命令与 `/reload` 集成。

### Modified Capabilities
- `session-store`: 新增 `updateSessionModel(id, model)`。
- `session-manager`: 新增 `setSessionModel(id, model)`。
- `session-cli`: `/resume` 恢复 session 的 model 到 agent。

## Impact

- 影响包：`chapter10`（唯一受影响，各 chapter 为独立 workspace package）。
- 新增 `chapter10/src/model/`（registry、types、loader）。
- 修改 `agent-loop.ts`、`cli.ts`、`client.ts`、`request-builder.ts`、`subagent/*`、`session/store.ts`、`session/manager.ts`。
- 文档：`chapter10/README.md`、根 `README.md`。
- 无新依赖，无运行时 API 破坏（env 兜底保留旧行为）。
