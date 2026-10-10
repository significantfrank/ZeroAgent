# Chapter 3: Basic Agent Loop

这是一个基于 Responses API 的 ReAct Agent Loop。它整合流式响应、客户端维护的对话上下文、Function Calling、token usage 和 `AbortController`，并提供命令行单次提问与交互式 CLI。

## 运行

在仓库根目录执行：

```bash
pnpm install
pnpm --filter @zero-agent/chapter3 start "What's the weather like in Tokyo?"
# 不带 prompt 参数时进入交互模式
pnpm --filter @zero-agent/chapter3 start
```

`start` 直接执行 `src/index.ts`，不需要先构建 `dist`。如果需要验证编译产物，可以单独运行：

```bash
pnpm --filter @zero-agent/chapter3 build
```

配置环境变量：

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

`OPENAI_BASE_URL` 可以指向兼容 Responses API 的 MaaS 服务。不同服务对 SSE 事件、工具调用和 `store` 的支持可能不同。本项目默认使用 `store: false`，由客户端维护上下文。

CLI 每次请求都会发送以下 reasoning 配置：

```json
{
  "reasoning": {
    "effort": "high",
    "summary": "auto"
  }
}
```

只有模型和 MaaS 服务支持 reasoning，并且实际返回 `response.reasoning_text.delta` 事件时，终端才会显示灰色 reasoning。通过 Agent API 调用且没有显式提供 reasoning 配置时，默认 effort 为 `low`。

## Agent Loop

每个 `step` 包含一次模型 `turn`，以及该 turn 产生的本地工具执行：

```text
Step 1
  ├─ Turn 1：模型流式返回 reasoning / content / output items
  ├─ Act：客户端执行 get_weather
  └─ Observe：追加 function_call_output

Step 2
  ├─ Turn 2：携带完整本地 conversation 请求模型
  └─ 模型返回最终答案
```

`turn` 指一次 Responses API 请求到响应结束的过程；`step` 是 ReAct 循环的一轮，包含一次 turn 和该 turn 后的工具处理。每次模型响应结束后，Agent 进入下一 step 继续请求，直到收到最终答案、被取消或达到步数上限。

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

当前只注册一个本地 mock 工具：`get_weather`。Agent 通过 `response.output_item.done` 事件识别完整的 `function_call` 和带有 `phase: "final_answer"` 的最终回答。模型请求工具时，Agent 会：

1. 解析模型生成的 JSON 参数。
2. 在本地执行天气查询。
3. 生成 `function_call_output`。
4. 将工具调用和结果追加到 conversation。
5. 继续下一步请求模型。

一轮中多个工具任务会并发启动；CLI 按调用顺序显示，每个 `tool_call` 后紧接对应的 `tool_result`。`tool_result` 不是模型生成的内容，而是客户端执行工具后的观察结果。

## 流式事件

客户端直接使用 OpenAI SDK 的 Responses API。SDK 负责 HTTP 请求和 SSE 事件解析，Agent 消费流事件并转换成 `AgentEventType` 定义的事件。CLI 会区分：

- `reasoning`：灰色显示的推理增量。
- `content`：最终回答增量。
- `tool_call`：模型请求执行工具。
- `tool_result`：本地工具执行结果。
- `token_usage`：每次响应的输入、输出和总 token 数，在 `response.completed` 到达时显示。
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
- 重试、工具超时和复杂工具注册表。
- 历史持久化和上下文裁剪。

## 测试

测试使用本地 mock `fetch` 返回 SSE，不需要 API Key：

```bash
pnpm --filter @zero-agent/chapter3 typecheck
pnpm --filter @zero-agent/chapter3 test
```