## Context

chapter10 目前是 chapter9（subagent）的逐字节副本。model 在代码里只是一根裸字符串：

- `Agent.#model = options.model ?? OPENAI_MODEL ?? 'gpt-4o-mini'`，构造后不可变。
- `ResponsesClient` 在 CLI 启动时用 env 构造一次，baseUrl/apiKey 锁死。
- subagent 的 `model:` 是自由字符串（如 `deepseek/deepseek-chat`），不做校验。
- session 表里存了 `model` 列，但 `/resume` 从不读回，`/model` 也不存在。

本章把 model 提升为一等公民。约束沿用项目约定：显式 `.ts` 导入后缀、手写校验风格（subagent/command/skill loader 均如此）、Node 内置 test runner + mock fetch、无新增运行时依赖。

## Goals / Non-Goals

**Goals:**
- 让 model 可配置（`~/.zeroagent/auth.json` + `~/.zeroagent/models-config.json`）、可列出、可切换。
- 按 provider 解析 baseUrl/key 并构造请求，未配置的 model 回落到 env 直连。
- 用 model 配置门控 reasoning，并把规范档位翻译成 provider 值。
- 补齐 session 的 model 持久化闭环（`/model` 写回、`/resume` 恢复）。
- 统一 subagent `model:` 为 models-config 的 key 并在调用时校验。

**Non-Goals:**
- 不做 Responses → Chat Completions 翻译（兼容层留给后续章节）。
- 不给用户提供选 effort 档位的命令入口（effort 本章固定 `high`）。
- 不做项目级 models-config 覆盖（仅用户级）。
- 不引入 model 目录的远程拉取 / `etag` / `checkedAt` 等同步机制。

## Decisions

### D1: model 感知的 client（按 model 解析 provider）

`ResponsesClient` 增加一个可选构造参数 `resolveProvider?: (modelId: string) => ProviderCredentials | undefined`。`stream()` 在发请求前用 `request.model` 解析 provider，命中则用该 provider 的 baseUrl/key，否则用构造时的 env 兜底。内部按 provider 缓存 `OpenAI` 实例。

- **为什么**：`Agent` 保持「一个 client + 一个 model」不变，切换 model 只需改 model 字符串；解析逻辑集中在 client 层，最贴合教程叙事「client 不再绑定单一端点」。
- **替代方案**：
  - CLI 层维护 `Map<provider, ResponsesClient>` 并 `agent.setClient(...)`：需要给 Agent 引入可变 client 与 setter，subagent 的 client 传播也要单独处理，改动更散。
  - 切换时重建 Agent：丢弃 skills/tools/session 状态，需要大量重放，最差。
- **兼容性**：`resolveProvider` 可选，不传时行为与 chapter9 完全一致；未命中时回落到 env 兜底，故无破坏性变更。

### D2: JSON 配置 + 手写校验

auth.json 与 models-config.json 都是纯 JSON。loader 用 `JSON.parse` + 手写字段校验（与 subagent/command/skill loader 的手写风格一致），报错信息带文件路径与字段名。

- **为什么**：两个文件是数据而非 Markdown 模板，不需要 frontmatter；校验风格对齐现有 loader，教学连贯。
- **替代方案**：用 `zod`（chapter10 已有依赖，但仅 mcp/server.ts 用到）。放弃原因：配置 loader 全线手写，引入 zod 会让本章的校验风格与前面章节割裂。

### D3: 解析链与 env 兜底

```
model id → models-config 命中？
  是 → provider → auth.json → { baseUrl, key }
  否 → 原样 model 字符串 + env（OPENAI_API_KEY / OPENAI_BASE_URL）
```

`models-config` 里不存 baseUrl；auth.json 是端点与鉴权的权威。未命中的 model 直接当裸字符串走 env，保留 `gpt-4o-mini` 等 OpenAI 模型的旧行为。

- **替代方案**：强制所有 model 必须在 models-config 中注册、否则报错。放弃：会破坏现有默认模型与 env 用法，且 OpenAI 不必写进 auth.json。

### D4: reasoning 门控与档位翻译

- `reasoning: false`（或缺省）→ 不发 `reasoning` 字段。
- 有 `thinkingLevelMap` → 可用档 = value 非 null 的 key；把固定档 `high` 翻译成 `thinkingLevelMap['high']`；若为 null，就近取档：优先「不高于 high 的最高可用档」，否则「最低可用档」。翻译后的字符串直接作为 `reasoning.effort` 发送。
- 无 `thinkingLevelMap` 但 `reasoning: true` → 原样发 `{ effort: 'high', summary: 'auto' }`（兼容未配置的 OpenAI 类模型）。

`thinkingLevelMap` 的 key 固定为规范五档 `minimal/low/medium/high/max`，value 是 provider 自己的字符串（可为 null）。`maxTokens` 映射到 Responses API 的 `max_output_tokens`（`ResponsesRequest` 与 `PromptRequestBuilder` 各加一个可选字段）。

- **替代方案**：翻译放在 CLI 而非 agent 层。放弃：subagent 也有自己的 model，翻译必须在 agent 请求构建处统一做，否则 subagent 拿不到正确档位。

### D5: subagent model 校验放在调用时

subagent 的 `model:` 统一为 models-config 的 key。校验发生在 `createSubAgent` / 调用时（解析 model 时查 registry），未知 model 报错。

- **为什么**：subagent loader 目前不依赖 model registry，注入会破坏「loader 只解析文件」的分层；调用时校验一处覆盖 `@agent` 与 `run_subagent` 两条委派路径。
- **替代方案**：加载时校验。放弃：loader 需要额外依赖 registry，且 `/reload` 的加载顺序变复杂。

### D6: session model 持久化补全

新增 `SessionStore.updateSessionModel(id, model)`（SQL `UPDATE sessions SET model = ?, updated_at = ?`）与 `SessionManager.setSessionModel(id, model)`。`/model <id>` 切换后写回 active session；`/resume` 读回 `session.model` 并设到 agent。

- **为什么**：session 表已有 `model` 列，补上更新与恢复即可闭环，无需迁移 schema。
- **替代方案**：删除 model 列、每次 `/resume` 用当前全局 model。放弃：丢失「每个 session 记得自己的 model」的能力，且要改 schema。

## Risks / Trade-offs

- **[provider 端点与 Responses API 不兼容]（如 deepseek/glm 实为 chat-completions）→ 缓解**：本章明确只做路由不做翻译；README 注明「仅支持 Responses 兼容端点」，报错时提示用户。
- **[auth.json 含明文密钥] → 缓解**：文件固定放在 `~/.zeroagent/`，写进 `.gitignore`，README 提示权限；代码只读不打印 key。
- **[`summary: 'auto'` 对部分 provider 可能不支持] → 缓解**：属兼容层范畴，本章维持现状，未来章节用 compat 元数据处理。
- **[thinkingLevelMap 缺省时行为与 OpenAI 默认一致，但语义靠约定] → 缓解**：spec 用场景明确三种情况（无 map / 有 map / reasoning false）的可测行为。
