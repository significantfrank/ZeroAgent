# Chapter 11：可扩展的 Agent

Chapter 11 聚焦于解耦 AI provider、分层 Agent 事件协议，以及通过 Extension 扩展 Agent 行为。

## AI client 与 provider 抽象

Agent loop 通过统一的 `AiClient` 接口发送 `AiRequest`，并消费 provider-neutral 的 `AssistantMessageEvent` 流。Agent loop 不直接依赖 OpenAI SDK，也不解析具体 provider 的 wire events。

```text
Agent loop
  └─ AiClient.stream(AiRequest)
       └─ AssistantMessageEvent
```

- [`src/ai/ai-client.ts`](src/ai/ai-client.ts) 定义共享请求、工具、tool call 和流事件类型。`AiRequest` 包含模型标识、输入、tools、reasoning 和可选的 `AbortSignal`。
- [`src/ai/openai-client.ts`](src/ai/openai-client.ts) 实现 OpenAI Responses API，并把 provider 流规范化为 `AssistantMessageEvent`。
- `createAiClient(provider, options)` 按 provider 创建客户端；目前 `openai`、`glm` 和 `deepseek` 使用 OpenAI-compatible 实现。
- 后续可为其他协议增加 `AiClient` 实现和工厂路由，不需要修改 Agent loop 的 provider 事件处理逻辑。

## 分层事件协议

事件从 provider 到 Agent，再到 Extension，逐层表达更高层的生命周期：

```text
AssistantMessageEvent  →  AgentEvent  →  ExtensionEvent
provider 级                 Agent 级        Extension 级
```

| 层级 | 定义 | 表达内容 |
| --- | --- | --- |
| Provider | `AssistantMessageEvent` | 最细粒度的 assistant 流事件：响应开始、text/thinking/tool call 的 start/delta/end，以及 done/error。 |
| Agent | `AgentEvent` | Agent、turn、assistant message 和 tool execution 的生命周期；`message_update.assistantMessageEvent` 保留 provider 事件细节。 |
| Extension | `ExtensionEvent` | 在 `AgentEvent` 之外增加 `before_agent_start`，用于在请求构造前调整 system prompt 或注入消息。 |

```text
AgentEvent:
agent_start
  turn_start
    message_start
    message_update (AssistantMessageEvent)
    message_end
    tool_execution_start / tool_execution_update / tool_execution_end
  turn_end
agent_end
```

AgentEvent 不暴露内部 loop step。一次 turn 包含 assistant 响应及其关联的工具调用和结果：`turn_end` 表示该轮处理结束，`agent_end` 表示整个 Agent run 结束。Extension handlers 可以通过 `on(eventType, handler)` 监听 Agent lifecycle 事件。

## Extension 扩展

### 加载与重载

- 用户级扩展：`~/.zeroagent/extensions/*.ts`
- 项目级扩展：`<workdir>/.zeroagent/extensions/*.ts`

启动和 `/reload` 时都会加载扩展。项目级与用户级同名扩展时，以项目级版本覆盖。扩展模块必须有 default export，接收 `ExtensionAPI`；单个扩展加载失败会打印错误并跳过，不影响其他扩展。

### 注册 Hook、Command 和 Tool

扩展 API 支持 lifecycle hook、交互命令和 AI tools：

```ts
export default function (zeroagent) {
    zeroagent.on('before_agent_start', (event, ctx) => {
        event.systemPromptOptions.sections['project_context'] = 'Project-specific instructions.';
        event.systemPromptOptions.appendSystemPrompt += '\nAdditional instructions.';
        // ctx.input 是本次 Agent 输入。
    });

    zeroagent.registerCommand('hello', {
        description: 'Show a greeting',
        async handler(args, ctx) {
            console.log(`Hello, ${args || 'world'}!`);
            // ctx.input 是完整命令行，例如 "/hello Alice"。
        },
    });

    zeroagent.registerTool(
        {
            type: 'function',
            name: 'get_answer',
            description: 'Return the answer.',
            parameters: { type: 'object', properties: {} },
            strict: true,
        },
        async () => '42',
    );
}
```

- **Hook**：`before_agent_start` 在构造本次 AI 请求前触发。可修改 `systemPromptOptions.sections` 和 `appendSystemPrompt`；也可返回 `messages`，将 system/user/assistant 消息注入请求。
- **Command**：在交互模式下通过 `/hello` 或 `/hello Alice` 调用。handler 收到去掉命令名后的 `args` 和包含原始命令行的 `ctx`。
- **Tool**：工具定义会加入 AI 请求的 tools；模型发起对应 tool call 后执行 handler。handler 接收原始 function call 和解析后的参数，可返回字符串或 `ToolResult`。

`/reload` 会卸载并重新加载扩展注册的 hooks、commands 和 tools。

### 示例扩展

本章示例位于 [test-ext.ts](.zeroagent/extensions/test-ext.ts)，从 chapter11 目录启动交互模式后可测试：

- `/hello` 和 `/hello Alice`：验证扩展命令。
- 让模型调用 `get_answer`：验证扩展工具并返回 `42`。
- 每次 Agent 请求前触发 `before_agent_start`，将示例内容加入 system prompt。

## 运行

```bash
pnpm --filter @zero-agent/chapter11 start
```
