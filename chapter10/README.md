# Chapter 10：Model 管理

Chapter 10 把 model 从一根裸字符串提升为一等公民。model ID、provider 鉴权和端点统一从 `~/.zeroagent/` 配置读取，可列出、切换并按 provider 路由。本章新增：

- `~/.zeroagent/auth.json`：provider 的鉴权与端点（权威）。
- `~/.zeroagent/models-config.json`：model 的个性化配置。
- `/models`、`/model <id>` 命令，以及 `/reload`、`/resume` 的 model 闭环。

## 配置

### auth.json

放在 `~/.zeroagent/auth.json`，键为 provider 名：

```json
{
  "deepseek": {
    "baseUrl": "https://api.deepseek.com/v1",
    "type": "api_key",
    "key": "sk-..."
  },
  "glm": {
    "baseUrl": "https://open.bigmodel.cn/api/v1",
    "type": "api_key",
    "key": "..."
  }
}
```

`baseUrl` 是端点权威，models-config 中不再重复配置。`type` 当前仅支持 `api_key`。**该文件含明文密钥，请勿提交到版本控制。**

### models-config.json

放在 `~/.zeroagent/models-config.json`，键为 model id（也是发给 API 的 `model` 值）：

```json
{
  "deepseek-flash": {
    "provider": "deepseek",
    "name": "DeepSeek Flash",
    "reasoning": true,
    "thinkingLevelMap": {
      "minimal": null,
      "low": "low",
      "medium": null,
      "high": "high",
      "max": "max"
    },
    "maxTokens": 384000
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `provider` | 必填，必须精确匹配 `auth.json` 的键 |
| `name` | 可选，`/models` 的显示名 |
| `reasoning` | 可选，默认 `false`；为 `true` 时请求才携带 `reasoning` |
| `thinkingLevelMap` | 可选，把规范档位翻译成 provider 值；`null` 表示该档不可用 |
| `maxTokens` | 可选，映射到 `max_output_tokens` |

`thinkingLevelMap` 的 key 固定为规范五档 `minimal/low/medium/high/max`，value 才是 provider 实际接受的字符串。请求档位来自 agent 的当前 thinking level（默认 `high`）：若该档可用则直接翻译；若为 `null` 则就近取档（优先不高于请求档的最高可用档，否则最低可用档）。

### settings.json

放在 `~/.zeroagent/settings.json`，保存「当前正在使用」的 model 与 thinking level：

```json
{
  "currentModel": "deepseek-flash",
  "currentThinkingLevel": "high"
}
```

| 字段 | 说明 |
| --- | --- |
| `currentModel` | 启动时作为 active model；`/model` 切换后写回 |
| `currentThinkingLevel` | 启动时作为 active thinking level（`minimal/low/medium/high/max`）；`/thinking` 切换后写回 |

两个字段都可省略：`currentModel` 缺失或不再配置时，启动时选择 models-config 中的第一个 model；`currentThinkingLevel` 缺失时默认为 `high`。文件不存在时按空配置处理，首次 `/model` 或 `/thinking` 会自动创建。未配置任何 model 时 CLI 会提示配置位置并退出，不从 `.env` 回退。

## 命令

- `/models` — 列出所有 model，`*` 标记当前 active，显示 provider、reasoning 与可用档位。
- `/model <id>` — 切换 active model，写回当前 session，并保存到 `settings.json` 的 `currentModel`。
- `/thinking [level]` — 不带参数显示当前 thinking level；带参数切换并保存到 `settings.json` 的 `currentThinkingLevel`。
- `/reload` — 同时重载 `auth.json`、`models-config.json`、commands、skills、subagents。
- `/resume <id>` — 恢复 session 时同时恢复其记录的 model。

## 解析链

```
model id → models-config 命中
  是 → provider → auth.json → baseUrl + key → 按 provider 构造/缓存 client
  否 → 报错，不回退到环境变量
```

本章只做「路由」不做「Responses → Chat Completions 翻译」，因此 `auth.json` 里的端点需兼容 Responses API。`.env` 不再提供 model ID、API key 或 provider base URL；可选的 `ZEROAGENT_WORKDIR` 仍可用于覆盖工作目录。

## 运行

```bash
pnpm --filter @zero-agent/chapter10 start
```

进入交互模式后用 `/models` 查看、`/model <id>` 切换。subagent 的 `model:` 字段统一写 models-config 的 key，调用时校验，未知会报错。
