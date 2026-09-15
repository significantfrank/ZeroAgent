# Chapter 2: Basic Agent Loop

这是一个基于 Responses API 的最小 ReAct Agent Loop。它把 `chapter1` 中的流式响应、客户端上下文、Function Calling 和 `AbortController` 整合成一个可运行的 CLI。

## 运行

在仓库根目录执行：

```bash
pnpm install
pnpm --filter @zero-agent/chapter2 start "What's the weather like in Tokyo?"
# 对支持 reasoning 的模型启用 reasoning
pnpm --filter @zero-agent/chapter2 start --reasoning "Explain 258 * 263"
```

`start` 直接执行 `src/index.ts`，不需要先构建 `dist`。如果需要验证编译产物，可以单独运行：

```bash
pnpm --filter @zero-agent/chapter2 build
```

配置环境变量：

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

`OPENAI_BASE_URL` 可以指向兼容 Responses API 的 MaaS 服务。不同服务对 SSE 事件、工具调用和 `store` 的支持可能不同。本项目默认使用 `store: false`，由客户端维护上下文。

默认不会请求 reasoning。使用 `--reasoning` 后，Agent 会发送：

```json
{
  "reasoning": {
    "effort": "high",
    "summary": "auto"
  }
}
```

只有模型和 MaaS 服务支持 reasoning，并且实际返回 `response.reasoning_text.delta` 或 `response.reasoning_summary_text.delta` 事件时，终端才会显示灰色 reasoning。当前 `deepseek-chat` 通常只返回最终答案；可以先确认服务商提供的 reasoning 模型和参数格式。

## Agent Loop

每个 `step` 包含一次模型 `turn`，以及该 turn 产生的本地工具执行：

```text
Step 1
  ├─ Turn 1：模型流式返回 reasoning / content / function_call
  ├─ Act：客户端执行 get_weather
  └─ Observe：追加 function_call_output

Step 2
  ├─ Turn 2：携带完整本地 conversation 请求模型
  └─ 模型返回最终答案
```

`turn` 指一次 Responses API 请求到响应结束的过程；`step` 是 ReAct 循环的一轮，包含一次 turn 和该 turn 后的工具处理。因此一个 step 至少包含一个 turn，但整个 run 可以有多个 step。

## 上下文管理

本项目不依赖 `previous_response_id`。客户端维护 `conversation`，第二轮请求会重放之前的消息、模型产生的 `function_call` 和本地生成的 `function_call_output`：

```text
user message
  ↓
assistant function_call
  ↓
function_call_output
  ↓
下一次 Responses API 请求
```

这种方式适合不支持服务端 Store 的服务，也方便调试和持久化。代价是历史越长，请求的 input token 越多；生产实现通常还需要增加历史裁剪、摘要或持久化。

## 工具调用

当前只注册一个 mock 工具：`get_weather`。模型请求工具时，Agent 会：

1. 解析模型生成的 JSON 参数。
2. 在本地执行天气查询。
3. 生成 `function_call_output`。
4. 将工具调用和结果追加到 conversation。
5. 继续下一步请求模型。

`tool_result` 不是模型生成的内容，而是客户端执行工具后的观察结果。

## 流式事件

客户端直接使用 OpenAI SDK 的 Responses API。SDK 负责 HTTP 请求和 SSE 事件解析，Agent 只消费标准化事件。CLI 会区分：

- `reasoning`：灰色显示的推理增量。
- `content`：最终回答增量。
- `tool_call`：模型请求执行工具。
- `tool_result`：本地工具执行结果。
- `step_end` / `run_end`：循环生命周期事件。

底层请求对应：

```typescript
const stream = await client.responses.create(
  { ...body, stream: true },
  { signal },
);

for await (const event of stream) {
  // 处理 response.output_text.delta、response.output_item.done 等事件
}
```

## 取消和限制

CLI 会监听 `SIGINT`，并通过 `AbortController` 取消当前请求：

```text
Ctrl+C → AbortController.abort() → fetch/SSE 停止 → Agent 结束
```

当前版本是教学用的基础实现，暂未包含：

- 服务端 `store` / `previous_response_id`。
- Structured Outputs。
- 并行工具调用。
- 重试、工具超时和复杂工具注册表。
- 历史持久化和上下文裁剪。

## 测试

测试使用本地 mock `fetch` 返回 SSE，不需要 API Key：

```bash
pnpm --filter @zero-agent/chapter2 typecheck
pnpm --filter @zero-agent/chapter2 test
```