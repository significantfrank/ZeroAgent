# Chapter 13: ZeroAgent SDK

Chapter 13 exposes an ADK-inspired TypeScript SDK for building an Agent
application with OpenAI-compatible models, typed function tools, and
multi-agent orchestration. The existing interactive CLI and its file-based
configuration remain available.

## SDK quick start

Install the published package:

```bash
npm install @zero-agent/chapter13
```

Set `OPENAI_API_KEY` and, for compatible services, `OPENAI_BASE_URL` in the
application environment or in a `.env` file in the current working directory.
The SDK loads that file when `OpenAICompatibleLlm` is constructed; variables
already set in the environment take precedence.

```ts
import {
  FunctionTool,
  LlmAgent,
  OpenAICompatibleLlm,
} from '@zero-agent/chapter13';

const getCurrentTime = new FunctionTool({
  name: 'get_current_time',
  description: 'Returns the current time in a specified city.',
  parameters: { city: 'The name of the city.' },
  execute: ({ city }) => ({ city, time: '10:30 AM' }),
});

const agent = new LlmAgent({
  name: 'hello_time_agent',
  model: new OpenAICompatibleLlm({
    model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
  }),
  description: 'Tells the current time in a specified city.',
  instruction: 'Use the get_current_time tool to answer time questions.',
  tools: [getCurrentTime],
});

const result = await agent.run('What time is it in Tokyo?', {
  signal: AbortSignal.timeout(60_000),
});
console.log(result.output);
```

`FunctionTool` accepts parameter descriptions as a shorthand object (each
parameter is treated as a required string) or a JSON Schema directly. It passes
model-provided arguments to its handler without runtime validation. Tool
results may be strings or JSON-serializable values. `LlmAgent.stream()` exposes
the existing typed Agent events for applications that need streaming UI updates.

To make a live LLM request using the current directory's `.env`, run:

```bash
pnpm --filter @zero-agent/chapter13 test:llm
```

The script uses `OPENAI_MODEL` when set (otherwise `gpt-4.1-mini`) and accepts
an optional prompt:

```bash
pnpm --filter @zero-agent/chapter13 test:llm -- "Explain what an Agent is."
```

To test parallel multi-agent orchestration against the live model:

```bash
pnpm --filter @zero-agent/chapter13 test:parallel
pnpm --filter @zero-agent/chapter13 test:parallel -- "Compare solar and wind power."
```

The script runs two agents concurrently with different instructions, then
prints each result in declaration order.

## Multi-agent orchestration

Use `AgentTool` when the parent model should decide whether to delegate. A
sequential workflow passes each step the original task and all earlier results.
A parallel workflow gives each agent the same input, runs them concurrently,
and returns results in declaration order. A failed parallel branch aborts its
siblings.

```ts
import {
  AgentTool,
  LlmAgent,
  OpenAICompatibleLlm,
  ParallelAgent,
  SequentialAgent,
} from '@zero-agent/chapter13';

const model = () => new OpenAICompatibleLlm({
  model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
});

const researcher = new LlmAgent({
  name: 'researcher',
  model: model(),
  instruction: 'Research the task and return concise findings.',
});
const writer = new LlmAgent({
  name: 'writer',
  model: model(),
  instruction: 'Write a concise answer using the supplied findings.',
});

const delegationAgent = new LlmAgent({
  name: 'coordinator',
  model: model(),
  instruction: 'Delegate research to the researcher tool, then summarize its result.',
  tools: [new AgentTool(researcher, {
    description: 'Delegate a research task to the researcher.',
  })],
});

const pipeline = new SequentialAgent({
  name: 'research-and-write',
  agents: [researcher, writer],
});
const reviewers = new ParallelAgent({
  name: 'parallel-review',
  agents: [researcher, writer],
});

const delegated = await delegationAgent.run('Compare two approaches.');
const written = await pipeline.run('Compare two approaches.');
const parallel = await reviewers.run('Review this proposal.');
console.log(delegated.output, written.output, parallel.children);
```

`run()` returns `{ name, output }`; workflow results also include ordered
`children`. Pass an `AbortSignal` to stop an agent or an entire workflow. Loop
workflows are not part of this initial SDK release.

Advanced runtime services are available from explicit package subpaths, keeping
the default SDK import lightweight:

```ts
import { SessionManager } from '@zero-agent/chapter13/session';
import { ExtensionRunner } from '@zero-agent/chapter13/extensions';
import {
  HindsightMemoryProvider,
  registerMemoryExtension,
} from '@zero-agent/chapter13/memory';
```

## Package development

From the ZeroAgent repository root:

```bash
pnpm --filter @zero-agent/chapter13 build
pnpm --filter @zero-agent/chapter13 typecheck
pnpm --filter @zero-agent/chapter13 test
cd chapter13 && npm pack --dry-run
```

The package root is an import-safe SDK entrypoint. The CLI has its own entry
point and does not run when consumers import the package:

```bash
pnpm --filter @zero-agent/chapter13 start
```

## Existing CLI and long-term memory

The CLI still uses `~/.zeroagent/` for provider, model, session, command, and
agent configuration. Chapter 13 also includes extension hooks and optional
Hindsight-backed long-term memory. The SDK can use an injected
`SessionManager` or `ExtensionRunner` through `LlmAgent` options; applications
can load Hindsight memory extensions explicitly instead of getting side effects
on import.

To use Hindsight, ensure its service is running (default
`http://localhost:8888`) and configure:

```bash
HINDSIGHT_BASE_URL=http://localhost:8888
HINDSIGHT_BANK_ID=zeroagent
```

## Hindsight integration test

```bash
pnpm --filter @zero-agent/chapter13 test:hindsight
```

The integration test uses a separate `hindsight-integration-test` bank by
default. `HINDSIGHT_BASE_URL` and `HINDSIGHT_BANK_ID` can override its settings.
