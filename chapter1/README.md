# Responses API 使用

Responses API 可以把普通问答、上下文管理、流式输出、结构化输出和工具调用统一到同一个接口中。本文结合 `chapter1/src` 下的 demo，说明六种常见用法。

## 准备工作

在 `chapter1/.env` 中配置访问参数：

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

也可以把 `OPENAI_BASE_URL` 指向兼容 Responses API 的 MaaS 服务。不同服务对模型、`store`、推理和工具调用的支持情况可能不同，需要以服务商文档和实际测试为准。

进入 `chapter1` 后执行以下命令：

```bash
npm install
npm start -- abort
npm start -- store
npm start -- store-client
npm start -- structured
npm start -- stream
npm start -- calling
```

## Demo 总览

| Demo | 命令 | 重点 |
| --- | --- | --- |
| 服务端 Store | `npm start -- store` | `store`、`previous_response_id` |
| 客户端上下文 | `npm start -- store-client` | 手动拼接历史消息 |
| 请求取消 | `npm start -- abort` | `AbortController`、SSE 中止 |
| 结构化输出 | `npm start -- structured` | JSON Schema、运行时校验 |
| 流式输出 | `npm start -- stream` | SSE 增量事件、token usage |
| 并行工具调用 | `npm start -- calling` | Function Calling、工具结果回传 |

所有 demo 都从环境变量读取 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL`。兼容 Responses API 不代表所有参数都被 MaaS 服务支持，尤其是服务端 Store、推理和结构化输出，运行前应确认服务商能力。

## 一、有状态 Store

Responses API 支持由服务端保存响应。请求中设置 `store: true` 后，服务端会保存本轮响应，并返回一个 response ID。下一轮请求通过 `previous_response_id` 引用上一轮响应，服务端就可以继续使用之前的上下文。

```json
// 第一轮 Request
{
  "model": "glm-5.3",
  "input": "我有三只猫。kitty, tom, and jerry.",
  "store": true
}
```

```json
// 第一轮 Response 的关键字段
{
  "id": "resp_20260913132836cc9a47c398b04d1c",
  "output_text": "..."
}
```

```json
// 第二轮 Request
{
  "model": "glm-5.3",
  "previous_response_id": "resp_20260913132836cc9a47c398b04d1c",
  "input": "它们分别叫什么名字？"
}
```

这里第二轮不需要再次发送第一轮的完整消息。模型服务会根据 `previous_response_id` 找到上一轮响应，因此能够理解“它们”指的是 `kitty`、`tom` 和 `jerry`。

需要注意：

- `previous_response_id` 依赖服务端确实保存了上一轮响应，因此通常需要使用 `store: true`。
- 服务商可能不支持有状态存储。实际测试中，DeepSeek 不支持该方式，而 GLM-5.3 支持。
- response ID 应由客户端保存，并在下一轮请求中传入。
- 服务端保存上下文可以减少客户端拼接历史的工作，但会产生服务端状态、保留时间、隐私和成本方面的约束。

对应代码是 [`src/store-demo.ts`](src/store-demo.ts)，运行：

```bash
npm start -- store
```

## 二、客户端维护上下文

如果服务商不支持 `store`，或者希望完全控制会话历史，可以在客户端保存消息，并在每次请求时把历史消息重新放入 `input`。这种方式不使用 `previous_response_id`，也不依赖服务端保存响应。

第一轮请求：

```json
{
  "model": "gpt-4o-mini",
  "input": [
    {
      "role": "user",
      "content": "我有三只猫。kitty, tom, and jerry."
    }
  ],
  "store": false
}
```

收到第一轮响应后，客户端把 assistant 的回答加入历史，再加入第二个 user 消息：

```typescript
history.push({ role: "assistant", content: resp1.output_text });
history.push({ role: "user", content: "它们分别叫什么名字？" });
```

第二轮把整个历史发送给模型：

```json
{
  "model": "gpt-4o-mini",
  "input": [
    {
      "role": "user",
      "content": "我有三只猫。kitty, tom, and jerry."
    },
    {
      "role": "assistant",
      "content": "第一轮模型的回答"
    },
    {
      "role": "user",
      "content": "它们分别叫什么名字？"
    }
  ],
  "store": false
}
```

这里的上下文管理完全发生在客户端：

```text
用户消息 → 请求模型 → 得到 assistant 消息
                         ↓
客户端保存 user + assistant 历史
                         ↓
下一轮发送完整 input
```

客户端维护的优点是行为明确、可迁移、容易实现本地持久化，也不依赖服务端的会话存储。缺点是历史越长，请求中的 input token 越多；客户端还需要自行处理历史裁剪、摘要、持久化和敏感信息保护。

对应代码是 [`src/store-client-demo.ts`](src/store-client-demo.ts)，运行：

```bash
npm start -- store-client
```

`store` 和客户端历史并不是只能二选一。实际项目可以使用 `store: false` 并由客户端管理主历史，也可以在需要服务端连续响应时使用 `previous_response_id`。关键区别是上下文的所有权：前者由客户端负责，后者由服务端负责。

## 三、AbortController

长时间运行的请求需要支持主动取消。`AbortController` 可以把 `AbortSignal` 传给 Responses API，取消正在进行的 HTTP 请求和 SSE 流，而不仅仅是停止读取已经返回的数据。

```typescript
const controller = new AbortController();

const stream = await client.responses.create(
  {
    model,
    input: "写一篇较长的文章，介绍人工智能的发展历史、当前应用和未来挑战。",
    stream: true,
  },
  { signal: controller.signal },
);

setTimeout(() => controller.abort(), 1500);

for await (const event of stream) {
  if (event.type === "response.output_text.delta") {
    process.stdout.write(event.delta);
  }
}
```

取消通常发生在三种场景：用户按下取消按钮、CLI 收到 `Ctrl+C`，或者应用达到超时时间。调用 `abort()` 后，正在进行的请求会抛出异常；应用应通过 `controller.signal.aborted` 区分“主动取消”和网络错误、API 错误。

对应代码是 [`src/abort-controller-demo.ts`](src/abort-controller-demo.ts)，运行：

```bash
npm start -- abort
```

## 四、Structured Outputs

Structured Outputs 用 JSON Schema 约束模型输出，使模型返回可以直接被程序解析的结构化 JSON，而不是需要从自然语言中猜测字段。它适合订单抽取、分类、信息抽取和后续 API 编排。

请求通过 `text.format` 声明 schema：

```json
{
  "model": "gpt-4o-mini",
  "input": "从这段文本提取订单信息：订单 A-1001 已支付，金额为 99.5 元。",
  "text": {
    "format": {
      "type": "json_schema",
      "name": "order_info",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": {
          "order_id": { "type": "string" },
          "status": { "type": "string", "enum": ["paid", "pending", "cancelled"] },
          "amount": { "type": "number" },
          "currency": { "type": "string" }
        },
        "required": ["order_id", "status", "amount", "currency"],
        "additionalProperties": false
      }
    }
  }
}
```

模型返回的 `output_text` 应该是 JSON 字符串：

```json
{
  "order_id": "A-1001",
  "status": "paid",
  "amount": 99.5,
  "currency": "CNY"
}
```

客户端仍然应该对结果进行 `JSON.parse` 和业务校验。Schema 约束输出格式，但不能替代业务层校验，也不能保证模型提供的信息本身真实正确。`strict: true` 会要求输出遵守 schema；模型或 MaaS 服务不支持该参数时，请求可能返回错误。

对应代码是 [`src/structured-output-demo.ts`](src/structured-output-demo.ts)，运行：

```bash
npm start -- structured
```

## 五、流式 Streaming

默认情况下，模型响应通常在完整生成后返回。设置 `stream: true` 后，Responses API 会通过 SSE（Server-Sent Events）逐个发送事件，客户端可以在模型生成过程中立即显示内容。

```typescript
const stream = await client.responses.create({
  model,
  input: "What is 17 * 24? Explain your reasoning step by step.",
  reasoning: { effort: "high" },
  stream: true,
});

for await (const event of stream) {
  switch (event.type) {
    case "response.reasoning_text.delta":
      process.stdout.write(event.delta);
      break;
    case "response.output_text.delta":
      process.stdout.write(event.delta);
      break;
    case "response.completed":
      console.log(event.response.usage);
      break;
  }
}
```

一次响应可能包含多种事件：

- `response.created`：响应开始。
- `response.reasoning_text.delta`：推理摘要或推理文本增量。
- `response.output_text.delta`：最终回答文本增量。
- `response.completed`：响应结束，同时可以读取最终状态和 token usage。

流式输出的关键点是：不要把所有事件都当成最终答案。reasoning、output text、工具调用和完成状态属于不同事件类型，应该分别处理。`chapter1/src/stream-demo.ts` 演示了如何区分 reasoning、output 和 usage。

对应命令：

```bash
npm start -- stream
```

## 六、并行 Function Calling

Function Calling 允许模型根据用户问题请求调用本地函数。模型只负责产生结构化的函数名和参数，真正执行函数的是客户端应用。

第一轮请求需要声明工具，并允许并行调用：

```json
{
  "model": "gpt-4o-mini",
  "input": "What's the weather like in New York and Tokyo right now?",
  "tools": [
    {
      "type": "function",
      "name": "get_weather",
      "description": "Get the current weather for a given city",
      "parameters": {
        "type": "object",
        "properties": {
          "city": { "type": "string" }
        },
        "required": ["city"],
        "additionalProperties": false
      },
      "strict": true
    }
  ],
  "parallel_tool_calls": true
}
```

模型可能返回两个 `function_call`：

```text
get_weather({"city":"New York"})
get_weather({"city":"Tokyo"})
```

客户端收到调用后执行本地函数，并为每个调用生成对应的 `function_call_output`：

```typescript
const toolOutputs = toolCalls.map((call) => ({
  type: "function_call_output" as const,
  call_id: call.call_id,
  output: mockGetWeather(args.city),
}));
```

然后把原始 `function_call` 和工具结果一起发回模型。客户端维护上下文时，不能只发送 `function_call_output`，因为服务端可能没有保存第一轮的工具调用。

```json
{
  "model": "gpt-4o-mini",
  "input": [
    {
      "role": "user",
      "content": "What's the weather like in New York and Tokyo right now?"
    },
    {
      "type": "function_call",
      "call_id": "call_...",
      "name": "get_weather",
      "arguments": "{\"city\":\"New York\"}"
    },
    {
      "type": "function_call_output",
      "call_id": "call_...",
      "output": "{\"city\":\"New York\",\"temperature_c\":22,\"condition\":\"sunny\"}"
    }
  ],
  "tools": [
    {
      "type": "function",
      "name": "get_weather",
      "description": "Get the current weather for a given city",
      "parameters": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"],
        "additionalProperties": false
      },
      "strict": true
    }
  ]
}
```

本 demo 使用 `store: false`，第二轮不使用 `previous_response_id`。这使它可以在不支持服务端 Store 的服务上运行，但代价是客户端必须保存并重放上下文；生产代码还需要处理工具执行失败、参数解析失败和超时。

完整流程是：

```text
用户问题
  ↓
模型返回一个或多个 function_call
  ↓
客户端解析参数并执行本地函数
  ↓
客户端生成 function_call_output
  ↓
模型读取工具结果并生成最终回答
```

`parallel_tool_calls: true` 表示模型可以在同一轮返回多个工具调用。客户端可以并发执行它们，再按照 `call_id` 把每个结果准确对应回去。工具结果不是模型生成的，而是客户端执行工具后生成的观察结果。

对应代码是 [`src/function-calling-demo.ts`](src/function-calling-demo.ts)，运行：

```bash
npm start -- calling
```

## 总结

Responses API 不只是一个文本生成接口，还提供了完整的模型交互能力：

- 使用服务端 Store 或客户端历史消息管理多轮上下文。
- 使用 SSE 流式接收 reasoning、回答文本和完成状态。
- 使用 `AbortController` 取消长时间运行的请求。
- 使用 JSON Schema 约束模型输出，得到可直接解析的结构化数据。
- 使用 Function Calling 让模型请求工具，由客户端执行工具并把结果反馈给模型。

这几个能力可以组合成一个完整的 Agent 流程：客户端保存或引用上下文，流式接收模型决策；如果模型请求工具，客户端执行工具并返回 `function_call_output`；如果任务耗时过长，则通过 `AbortController` 取消请求；最终使用结构化输出或普通文本返回结果。

实际项目中需要特别关注三点：服务商对 Responses API 参数的兼容性、上下文增长带来的 token 成本，以及工具执行失败和请求取消等异常情况。`chapter1` 中的 demo 分别展示了这些基础能力，可以作为进一步实现 ReAct Agent、上下文裁剪、重试和可观测性的起点。