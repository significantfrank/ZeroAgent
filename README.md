# ZeroAgent

A **ReAct agent loop** for the **OpenAI Responses API**, written in TypeScript, with streaming output
that keeps **reasoning**, **content** and **tool calls** on separate channels.

This repository contains two reusable packages and two Responses API tutorial projects:

| Package | Description |
| --- | --- |
| [`@zero-agent/agent-loop`](packages/agent-loop) | The library. Agent loop, streaming Responses client, SSE parser, tool registry. **Zero runtime dependencies.** |
| [`@zero-agent/cli`](packages/cli) | Interactive terminal app built on the library. |
| [`chapter1`](chapter1) | Standalone Responses API capability demos. |
| [`@zero-agent/chapter3`](chapter3) | Standalone ReAct Agent Loop tutorial with an interactive CLI. |

## Quick start

```bash
pnpm install
pnpm --filter @zero-agent/chapter3 start "What's the weather like in Tokyo?"
pnpm --filter @zero-agent/chapter3 test
pnpm demo            # offline library demo against a local mock server; no API key needed
```

For the Responses API capability demos, see [`chapter1/README.md`](chapter1/README.md). For the
library and packaged CLI, see [`packages/agent-loop/README.md`](packages/agent-loop/README.md).

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
pnpm-workspace.yaml        packages/* plus chapter projects
tsconfig.json              root TypeScript solution references
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
    test/                  CLI argument and end-to-end tests
chapter1/                  standalone Responses API demos and its own npm package
chapter3/                  workspace package with a standalone ReAct Agent Loop CLI
  src/                      Responses client, Agent Loop, CLI, tools and event types
  test/                     mocked SSE integration tests
```

## How the workspace is wired

- **pnpm workspaces.** `@zero-agent/cli` depends on `@zero-agent/agent-loop` through
  `"workspace:*"`, which pnpm links into `packages/cli/node_modules`.
- **TypeScript project references.** The library and packaged CLI use project references; the CLI
  references the library. The root `tsconfig.json` currently still references the removed `chapter2`
  project and omits `chapter3`, so root-level build commands need that configuration updated.
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
| `pnpm build` | Root TypeScript build; currently fails because root `tsconfig.json` references removed `chapter2` |
| `pnpm clean` | Cleans TypeScript output; root clean script still mentions removed `chapter2` |
| `pnpm typecheck` | Runs `typecheck` in workspace packages |
| `pnpm test` | Builds the workspace, then runs package test suites; currently blocked by the stale root `chapter2` reference |
| `pnpm demo` | Offline ReAct demo from the library package |
| `pnpm cli` | Builds, then runs the packaged CLI; currently blocked by the stale root `chapter2` reference |

Per-package commands: `pnpm --filter @zero-agent/agent-loop <script>`,
`pnpm --filter @zero-agent/cli <script>`, or `pnpm --filter @zero-agent/chapter3 <script>`.

## Requirements

Node ≥ 22.18 (developed on 24.13) and pnpm 11. The library has **no runtime dependencies**; the only
dev dependencies are `typescript` and `@types/node`.

## Testing

Run the independent chapter3 test suite with:

```bash
pnpm --filter @zero-agent/chapter3 test
pnpm --filter @zero-agent/chapter3 typecheck
```

The chapter3 test uses a mock `fetch` and SSE responses, so it requires no API key. The library and
packaged CLI have their own test scripts; run them with the corresponding `pnpm --filter` command.
