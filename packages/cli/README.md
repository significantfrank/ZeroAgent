# @zero-agent/cli

Interactive terminal app for the [ZeroAgent](../agent-loop) ReAct agent loop.

Streaming output is rendered **per channel**, so the model's reasoning, its answer text and its tool
traffic are visually distinct instead of interleaved. Real captured output:

```
[reasoning] I should compute this with the calculator.
[content] Let me calculate that.
[tool_call] {"expression":"(17 * 3 + 4) / 5"}
[tool_call] calculator({"expression":"(17 * 3 + 4) / 5"})
[tool_result] ✓ calculator (2ms) → {"expression":"(17 * 3 + 4) / 5","result":11}
[reasoning] The tool returned 11.
[content] The answer is 11.
```

The bare `[tool_call]` line is the argument JSON streaming in; the following line is the completed
call. Lifecycle lines (`[status] run start…`, per-step summaries) are shown only with `--verbose`.

## Usage

From the repo root (`pnpm` forwards arguments directly — do **not** add `--`):

```bash
pnpm cli --help
pnpm cli --model gpt-5 --effort low
pnpm cli -p "What is (17*3+4)/5?"
```

Or run the built binary directly:

```bash
node packages/cli/dist/cli.js --help
```

Create a `.env` file in the repository root for local configuration:

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5
```

The CLI loads these values automatically. Shell environment variables and command-line options take
precedence where applicable. `OPENAI_BASE_URL` and `OPENAI_MODEL` are also honoured for
OpenAI-compatible gateways.

```
-p, --prompt <text>      Run a single prompt and exit.
-m, --model <id>         Model id (default: $OPENAI_MODEL or "gpt-5").
    --base-url <url>     API base URL (default: $OPENAI_BASE_URL).
    --instructions <s>   System instructions.
    --max-steps <n>      Maximum ReAct iterations (default: 10).
    --effort <level>     Reasoning effort: minimal|low|medium|high.
    --summary <mode>     Reasoning summary: auto|concise|detailed.
    --no-reasoning       Do not request or display reasoning.
    --no-tools           Run without tools.
    --no-color           Disable ANSI colours.
-v, --verbose            Show lifecycle events.
-h, --help               Show this help.
```

Session commands: `/reset` clears the conversation history, `/exit` quits. In an interactive session
the first `Ctrl-C` aborts the current run and a second one exits.

Exit codes: `0` success, `1` the run failed or the API rejected the request, `2` bad usage.

## Design

The package is split so that all argument handling is testable without the agent:

- **`src/args.ts`** — pure parsing. No import of `@zero-agent/agent-loop` at all; it produces plain
  option values that `cli.ts` maps onto the agent's own types. Its 15 tests run without the library
  being built.
- **`src/cli.ts`** — wiring and side effects: builds the agent and renderer, drives the
  reason/act/observe loop, manages the session transcript and `SIGINT`.

`test/cli.e2e.test.ts` adds 4 integration tests that spawn the **built** CLI against a live mock
Responses API server. They are what actually verify the workspace wiring end to end: the CLI resolves
`@zero-agent/agent-loop` through the pnpm link into the library's `dist`, streams a turn, executes a
tool and feeds the observation back on a second request. They skip with a clear message if `dist` is
missing, so run `pnpm build` first (`pnpm test` at the repo root does this for you).

A failed or aborted turn is deliberately **not** appended to the conversation, so one bad turn does
not poison the rest of the session.

## Scripts

| Command | Effect |
| --- | --- |
| `pnpm build` | `tsc -b` (builds `@zero-agent/agent-loop` first via project references) |
| `pnpm typecheck` | Build, then `noEmit` typecheck of `src` + `test` |
| `pnpm test` | `node --test "test/**/*.test.ts"` |
| `pnpm start` | `node dist/cli.js` |
