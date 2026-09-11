# ZeroAgent

A **ReAct agent loop** for the **OpenAI Responses API**, written in TypeScript, with streaming output
that keeps **reasoning**, **content** and **tool calls** on separate channels.

This repository is a pnpm workspace containing two packages:

| Package | Description |
| --- | --- |
| [`@zero-agent/agent-loop`](packages/agent-loop) | The library. Agent loop, streaming Responses client, SSE parser, tool registry. **Zero runtime dependencies.** |
| [`@zero-agent/cli`](packages/cli) | Interactive terminal app built on the library. |

## Quick start

```bash
pnpm install
pnpm build          # tsc -b across the workspace
pnpm test           # 168 tests (149 library + 19 CLI)

pnpm demo           # offline end-to-end ReAct run against a local mock server — no API key needed
pnpm cli --help     # interactive CLI (pnpm forwards arguments directly, so no "--")
```

For local credentials and model settings, create a `.env` file in the repository root:

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5
```

The CLI loads `.env` automatically. The file is ignored by Git.

Minimal library usage:

```ts
import { ReActAgent, ResponsesClient, builtinTools, channelOf } from '@zero-agent/agent-loop';

const agent = new ReActAgent({
  client: new ResponsesClient(),          // reads OPENAI_API_KEY
  model: 'gpt-5',
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

## The three channels

The Responses API multiplexes reasoning, answer text and tool calls onto a single SSE stream
(distinguished by event name plus `output_index`/`item_id`). The library demultiplexes it into one
discriminated union, `AgentEvent`, classified by `channelOf(event)`:

| Channel | Events | What it carries |
| --- | --- | --- |
| `reasoning` | `reasoning_delta`, `reasoning_done` | The model's thinking. `part: 'summary'` for the API's reasoning summary, `part: 'text'` for raw reasoning content. |
| `content` | `content_delta`, `content_done`, `refusal_delta`, `refusal_done` | Assistant-visible text: the answer, and refusals. |
| `tool_call` | `tool_call_delta`, `tool_call` | The model requesting a tool. Argument JSON streams incrementally. |
| `tool_result` | `tool_result` | The observation produced by running a tool. |
| `status` | `run_start`, `step_start`, `response_start`, `step_end`, `run_end` | Lifecycle and progress. |
| `error` | `error` | Recoverable and fatal failures. |

Because `AgentEvent` is a discriminated union, `switch (event.type)` narrows the payload — no casts,
no guessing which string field holds the text.

See [`packages/agent-loop/README.md`](packages/agent-loop/README.md) for the full design notes.

## Repository layout

```
package.json               workspace root: private, dev tooling, aggregate scripts
pnpm-workspace.yaml        packages/*
tsconfig.json              solution file — `tsc -b` builds every referenced project
tsconfig.base.json         shared compiler options inherited by every package
packages/
  agent-loop/              the library
    src/                   agent/, openai/, tools/, util/
    test/                  149 tests, incl. a real SSE mock server
    examples/demo.ts       offline end-to-end demo
    tsconfig.json          composite build -> dist
    tsconfig.test.json     noEmit typecheck of src + test + examples
  cli/                     the terminal app
    src/cli.ts             wiring and side effects
    src/args.ts            pure argument parsing (no dependency on the library)
    test/args.test.ts      15 argument-parsing tests (no library dependency)
    test/cli.e2e.test.ts    4 tests that run the built CLI against a live SSE server
```

## How the workspace is wired

- **pnpm workspaces.** `@zero-agent/cli` depends on `@zero-agent/agent-loop` through
  `"workspace:*"`, which pnpm links into `packages/cli/node_modules`.
- **TypeScript project references.** `tsc -b` at the root builds both projects in dependency order
  from the solution-style `tsconfig.json`. The CLI declares
  `"references": [{ "path": "../agent-loop" }]`, so it can never typecheck against a stale library.
- **Each package emits to `dist`** (`composite: true`, declarations + declaration maps + source
  maps), and its `exports` map points at `dist`. That is what the CLI resolves through the
  `@zero-agent/agent-loop` specifier.
- **Sources still run directly.** Imports keep their explicit `.ts` extensions and the build sets
  `rewriteRelativeImportExtensions`, so emitted JS gets correct `.js` specifiers while tests,
  examples and the demo run straight from TypeScript via Node's native type stripping — no build step
  needed to run `pnpm test` or `pnpm demo`.
- **`erasableSyntaxOnly`** keeps the source free of non-strippable syntax (`enum`, parameter
  properties), which is what makes that direct execution work.
- **Separate test tsconfigs.** Build configs are `composite` and emit; `tsconfig.test.json` files are
  `noEmit` and include the test sources, so tests are typechecked without being emitted into `dist`.

## Scripts

| Command | Effect |
| --- | --- |
| `pnpm build` | `tsc -b` — builds every package in dependency order |
| `pnpm clean` | Removes build output via `tsc -b --clean` |
| `pnpm typecheck` | `pnpm -r typecheck` — builds, then checks tests/examples with `noEmit` |
| `pnpm test` | `pnpm -r test` — runs each package's `node --test` suite |
| `pnpm demo` | Offline ReAct demo from the library package |
| `pnpm cli` | Builds, then runs the CLI (`pnpm cli --help`) |

Per-package commands: `pnpm --filter @zero-agent/agent-loop <script>`.

## Requirements

Node ≥ 22.18 (developed on 24.13) and pnpm 11. The library has **no runtime dependencies**; the only
dev dependencies are `typescript` and `@types/node`.

## Testing

`pnpm test` builds the workspace and then runs 168 tests.

The **library** suite (149 tests) drives the agent against a **real** `node:http` server that speaks
the Responses API SSE protocol, so the SSE parser, the streaming UTF-8 decoder, chunked transfer
encoding, HTTP error mapping and the full ReAct loop are exercised end to end — including single-byte
chunk fragmentation, connections dropped mid-stream, `429` retries, truncated streams and concurrency
of parallel tool calls.

The **CLI** suite (19 tests) covers argument parsing in isolation, plus 4 integration tests that spawn
the **built** CLI binary against a live mock server. Those are what verify the monorepo wiring: the
CLI resolves `@zero-agent/agent-loop` through the pnpm workspace link into the library's `dist`, and a
complete tool round-trip succeeds over real HTTP.
