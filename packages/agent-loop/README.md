# @zero-agent/agent-loop

A **ReAct agent loop** for the **OpenAI Responses API**, written in TypeScript, with streaming output
that keeps **reasoning**, **content** and **tool calls** on separate channels.

Zero runtime dependencies: the transport is built directly on `fetch` + `ReadableStream`, and the
source runs on plain `node` thanks to Node's native TypeScript support.

```ts
import { ReActAgent, ResponsesClient, builtinTools, channelOf } from '@zero-agent/agent-loop';

const agent = new ReActAgent({
  client: new ResponsesClient(),            // reads OPENAI_API_KEY
  model: 'gpt-5',
  instructions: 'You are a precise assistant. Use tools when they help.',
  tools: builtinTools(),
  reasoning: { effort: 'low', summary: 'auto' },
});

for await (const event of agent.stream('What is (17 * 3 + 4) / 5?')) {
  switch (channelOf(event)) {
    case 'reasoning':   process.stderr.write(event.delta); break;  // the model thinking
    case 'content':     process.stdout.write(event.delta); break;  // the answer
    case 'tool_call':   if (event.type === 'tool_call') log('→', event.name, event.arguments); break;
    case 'tool_result': log('←', event.output); break;
    default: break;                                                // status / errors
  }
}
```

---

## The three channels

The Responses API multiplexes everything onto one SSE stream. This library demultiplexes it into a
single discriminated union, `AgentEvent`, whose members are classified by `channelOf(event)`:

| Channel | Events | What it carries |
| --- | --- | --- |
| `reasoning` | `reasoning_delta`, `reasoning_done` | The model's thinking. `part: 'summary'` for the API's reasoning summary, `part: 'text'` for raw reasoning content. |
| `content` | `content_delta`, `content_done`, `refusal_delta`, `refusal_done` | Assistant-visible text: the answer, and refusals. |
| `tool_call` | `tool_call_delta`, `tool_call` | The model requesting a tool. Arguments stream incrementally as JSON fragments. |
| `tool_result` | `tool_result` | The observation produced by running a tool. |
| `status` | `run_start`, `step_start`, `response_start`, `step_end`, `run_end` | Lifecycle and progress. |
| `error` | `error` | Recoverable and fatal failures. |

Because `AgentEvent` is a discriminated union, `switch (event.type)` narrows the payload — no casts,
no `as any`, no guessing which string field holds the text.

Key details that make the separation reliable:

- **Reasoning vs. content** is decided per *output item*, tracked by `output_index`/`item_id`, not by
  matching on event names alone. `reasoning_summary_text.delta`, `reasoning_text.delta` and
  `output_text.delta` can interleave; each is attributed to its own item.
- **Tool calls open early.** A `tool_call_delta` with an empty `argsDelta` is emitted as soon as the
  model opens a function call, so a UI can show "calling `search`…" before any arguments arrive.
- **Argument JSON streams incrementally**, then a single `tool_call` event carries the parsed
  `args` object (plus `parseError` if the model produced invalid JSON).
- **Truncated streams still complete.** `response.output_item.done`, the `*_done` events and
  `response.completed` each act as finalisers, and `response.output` is treated as the source of
  truth, so no `*_done`/`tool_call` event is ever lost.

## The ReAct loop

Each iteration is one Reason → Act → Observe cycle:

```
step 1 ──► POST /v1/responses  (stream: true)
           ├── reasoning_delta …        → "reasoning" channel
           ├── content_delta   …        → "content"   channel
           └── tool_call_delta … tool_call
                    │
                    ├─ execute tool(s) ─► tool_result event → "tool_result" channel
                    └─ append function_call + function_call_output to input
step 2 ──► POST /v1/responses  (input now includes the observation)
           └── content_delta "The answer is 11."
```

Termination: the model answers without calling a tool (`completed`), the step budget runs out
(`max_steps`), the run is aborted (`aborted`), the response is incomplete (`incomplete`), or the API
fails (`failed`).

Conversation state is carried as plain Responses API input items, so the loop works with
`store: false` and needs no server-side conversation object. `AgentResult.messages` is the full
transcript — append a user message and pass it straight back to continue the conversation.

## Install & run

This package lives in a pnpm workspace. From the **repo root**:

```bash
pnpm install
pnpm build                              # tsc -b: emits dist/ for both packages

pnpm --filter @zero-agent/agent-loop test
pnpm demo                               # full ReAct run against a local mock server, no API key
pnpm cli --help                         # the CLI lives in @zero-agent/cli
```

Or from this directory:

```bash
pnpm test        # node --test "test/**/*.test.ts"
pnpm demo        # node examples/demo.ts
pnpm build       # tsc -b tsconfig.json
pnpm typecheck   # build, then noEmit check of src + test + examples
```

The tests and the demo import from `src/*.ts` and run directly through Node's type stripping, so
neither needs a build step. Building only matters for consumers that import the package by name.

## API

### `ReActAgent`

```ts
const agent = new ReActAgent({
  client,                      // ResponsesClient
  model: 'gpt-5',
  instructions?: string,
  tools?: ToolRegistry | ToolDefinition[],
  maxSteps?: number,           // default 10
  reasoning?: { effort, summary },
  temperature?, topP?, maxOutputTokens?,
  store?: boolean,             // default false
  parallelToolCalls?: boolean, // default false (sequential)
  toolTimeoutMs?: number,      // default 60_000
  maxToolOutputChars?: number, // default 30_000
  echoAssistantMessages?: boolean, // default true
  echoReasoningItems?: boolean,    // default false
  toolChoice?, signal?, log?,
  throwOnError?: boolean,      // default false: errors are reported as events
  requestOverrides?,
});
```

Three ways to consume it, all driven by the same generator:

```ts
// 1. Raw typed events (the generator's return value is the AgentResult)
for await (const event of agent.stream(input)) { /* … */ }

// 2. Aggregated result only
const result = await agent.run('What is 2+2?');

// 3. Typed callbacks — the most convenient when the three channels go to
//    three different places
await agent.runWithCallbacks('What is 2+2?', {
  onReasoningDelta: (delta) => thinkingPane.append(delta),
  onContentDelta:   (delta) => answerPane.append(delta),
  onToolCall:       (call)  => log(`→ ${call.name}(${call.arguments})`),
  onToolResult:     (res)   => log(`← ${res.output}`),
});
```

`AgentResult`:

```ts
{
  text, reasoningText, reasoning: AgentReasoningBlock[],
  steps: AgentStep[], toolCalls, toolResults,
  usage, stopReason, responseIds, messages, durationMs, error?
}
```

Input can be a string, a string array (each becomes a user message), a single input item, or a list
of input items (e.g. `AgentResult.messages` from a previous run).

### Tools

```ts
import { defineTool, ToolRegistry } from '@zero-agent/agent-loop';

const weather = defineTool({
  name: 'get_weather',
  description: 'Look up the current weather for a city.',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string' },
      unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
    },
    required: ['city'],
    additionalProperties: false,
  },
  async execute(args: { city: string; unit?: string }, ctx) {
    ctx.log(`looking up ${args.city}`);
    return fetchWeather(args.city, args.unit ?? 'celsius', { signal: ctx.signal });
  },
});

const agent = new ReActAgent({ client, model: 'gpt-5', tools: new ToolRegistry({ tools: [weather] }) });
```

`defineTool` is an identity function that preserves the concrete argument type, so `execute` bodies
are fully typed. The registry converts tools to the **flat** Responses format
(`{ type, name, description, parameters }`) — note this differs from Chat Completions' nested
`{ type, function: { … } }` shape.

Tool execution **never throws**. Unknown tool, unparseable arguments, schema violations, a thrown
implementation, and timeouts all become structured observations that are fed back to the model, so
the loop can recover instead of crashing:

```json
{"error":"Invalid arguments for \"get_weather\": arguments.unit: must be one of \"celsius\", \"fahrenheit\". Expected schema: …"}
```

Built-in examples: `calculator` (a safe recursive-descent expression evaluator — never `eval`),
`current_time`, and `memory` (a stateful scratchpad demonstrating cross-step state).

### `ResponsesClient`

```ts
const client = new ResponsesClient({
  apiKey?, baseURL?, organization?, project?, headers?,
  fetch?,          // inject your own transport
  maxRetries?,     // default 2
  retryDelayMs?,   // default 500
  timeoutMs?,      // off by default: a reasoning turn can legitimately be slow
  onUnknownEvent?, // observe event types this library does not model yet
});
```

- Retries connection failures and `408/409/429/5xx` with exponential backoff and `Retry-After`
  support — **only before the body is consumed**, so a consumer never sees duplicated events.
- Surfaces structured `OpenAIError`s with `status`, `code`, `type`, `param`, `requestId`, `retryable`.
- Unknown SSE event types are skipped rather than breaking the typed stream, and are reported through
  `onUnknownEvent` for forward compatibility.

## Design notes

- **Streaming-first.** Deltas are forwarded the moment they are decoded; nothing is buffered until a
  turn ends. `displayText(event)` returns just the incremental text for an event, and
  `ConsoleRenderer` shows the intended per-channel rendering.
- **Stateless by default.** `store: false`, with the transcript carried in `input`. If you enable
  `echoReasoningItems`, `include: ["reasoning.encrypted_content"]` is added automatically, which the
  API requires for reasoning items to be accepted back when `store` is false.
- **Robust SSE parsing.** The parser is incremental and handles chunk boundaries anywhere, including
  a `\r\n` pair split across two chunks and multi-line `data:` fields. A chunk boundary landing on a
  line terminator is *not* mistaken for the blank line that ends an event.
- **Forward compatible.** Only modelled event types reach the typed stream, so `switch` stays
  exhaustive and new API features cannot silently break consumers.
- **TypeScript you can run as-is.** The source uses only *erasable* TypeScript syntax
  (`erasableSyntaxOnly`), so `node examples/demo.ts` executes it directly — no `enum`, no parameter
  properties. Relative imports carry explicit `.ts` extensions (required by Node's type stripping)
  and the build sets `rewriteRelativeImportExtensions`, so the emitted `dist/` gets correct `.js`
  specifiers while the sources stay directly runnable.

## Project layout

```
src/
  index.ts                  public API
  agent/
    events.ts               AgentEvent union, channelOf, AgentResult
    accumulator.ts          ResponseStreamEvent -> AgentEvent, per-item state
    loop.ts                 the ReAct loop
    display.ts              console rendering per channel
  openai/
    sse.ts                  incremental SSE parser
    types.ts                Responses API wire types
    responses.ts            streaming fetch client + retries
  tools/
    types.ts                JSON Schema + argument validation
    registry.ts             registration, guarded execution, timeouts
    calculator.ts           safe expression evaluator
    builtin.ts              example tools
  util/errors.ts            error normalisation
test/                       149 tests, incl. a real SSE mock server
examples/demo.ts             offline end-to-end demo
tsconfig.json                composite build -> dist
tsconfig.test.json           noEmit typecheck of src + test + examples
```

The interactive CLI is a separate workspace package: [`@zero-agent/cli`](../cli).

## Testing

`pnpm test` runs 149 tests. The suite drives the agent against a **real**
`node:http` server that speaks the Responses API SSE protocol, so the SSE parser, the streaming
UTF-8 decoder, chunked transfer encoding, HTTP error mapping and the full ReAct loop are all
exercised end to end — including single-byte chunk fragmentation, connections dropped mid-stream,
`429` retries, truncated streams and concurrency of parallel tool calls.

The unit-test helpers (`test/helpers/responses-script.ts`) build event sequences that mirror the real
API's ordering, and can deliberately omit `response.completed` or `*_done` events to prove the
finalisation paths.

## Status

Runs on Node ≥ 22.18 (developed on 24.13). The Responses API evolves quickly; the client is designed
so unrecognised events are observable via `onUnknownEvent` rather than fatal.
