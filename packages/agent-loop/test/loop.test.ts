import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAIError, ResponsesClient } from '../src/openai/responses.ts';
import { ReActAgent, assistantMessage, normalizeInput, userMessage } from '../src/agent/loop.ts';
import type { ReActAgentOptions } from '../src/agent/loop.ts';
import { channelOf } from '../src/agent/events.ts';
import type { AgentChannel, AgentEvent, AgentResult } from '../src/agent/events.ts';
import { builtinTools, calculatorTool, createMemoryTool } from '../src/tools/builtin.ts';
import { defineTool } from '../src/tools/types.ts';
import { startMockResponsesServer } from './helpers/mock-server.ts';
import type { MockResponsesServer } from './helpers/mock-server.ts';
import { buildTurn } from './helpers/responses-script.ts';
import type { TurnSpec } from './helpers/responses-script.ts';

/** Serve `turns[index]`, repeating the last turn if more requests arrive. */
async function scriptedServer(turns: readonly TurnSpec[]): Promise<MockResponsesServer> {
  return startMockResponsesServer((_request, index) => {
    const spec = turns[Math.min(index, turns.length - 1)];
    if (spec === undefined) throw new Error(`no scripted turn for request #${index}`);
    return { events: buildTurn(spec) };
  });
}

function makeAgent(url: string, overrides: Partial<ReActAgentOptions> = {}): ReActAgent {
  return new ReActAgent({
    client: new ResponsesClient({ apiKey: 'k', baseURL: url, maxRetries: 0 }),
    model: 'gpt-mock',
    ...overrides,
  });
}

async function collect(agent: ReActAgent, input: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.stream(input)) events.push(event);
  return events;
}

function channelsUsed(events: readonly AgentEvent[]): Set<AgentChannel> {
  return new Set(events.map((event) => channelOf(event)));
}

/* -------------------------------------------------------------------------- */
/* Single-step runs                                                           */
/* -------------------------------------------------------------------------- */

test('answers in one step when no tool is needed', async () => {
  const server = await scriptedServer([
    { reasoning: ['The user just ', 'greeted me.'], content: ['Hello! ', 'How can I help?'] },
  ]);

  try {
    const agent = makeAgent(server.url);
    const events = await collect(agent, 'hi');

    assert.deepEqual(
      events.map((event) => event.type),
      [
        'run_start',
        'step_start',
        'response_start',
        // The reasoning item is closed out before the message item begins,
        // which is the order the real API uses.
        'reasoning_delta',
        'reasoning_delta',
        'reasoning_done',
        'content_delta',
        'content_delta',
        'content_done',
        'step_end',
        'run_end',
      ],
    );

    const runEnd = events.at(-1);
    assert.equal(runEnd?.type, 'run_end');
    if (runEnd?.type === 'run_end') {
      assert.equal(runEnd.stopReason, 'completed');
      assert.equal(runEnd.text, 'Hello! How can I help?');
      assert.equal(runEnd.reasoning, 'The user just greeted me.');
      assert.equal(runEnd.steps, 1);
    }
  } finally {
    await server.close();
  }
});

test('keeps reasoning and content text strictly on their own channels', async () => {
  const server = await scriptedServer([
    {
      reasoning: ['REASONING-MARKER-A', 'REASONING-MARKER-B'],
      content: ['CONTENT-MARKER-A', 'CONTENT-MARKER-B'],
    },
  ]);

  try {
    const agent = makeAgent(server.url);
    const events = await collect(agent, 'go');

    const reasoningDeltas = events.filter((event) => event.type === 'reasoning_delta');
    const contentDeltas = events.filter((event) => event.type === 'content_delta');

    assert.ok(reasoningDeltas.length > 0);
    assert.ok(contentDeltas.length > 0);

    for (const event of reasoningDeltas) {
      assert.match(event.delta, /REASONING-MARKER/);
      assert.doesNotMatch(event.delta, /CONTENT-MARKER/);
    }
    for (const event of contentDeltas) {
      assert.match(event.delta, /CONTENT-MARKER/);
      assert.doesNotMatch(event.delta, /REASONING-MARKER/);
    }

    // The two channels are genuinely different destinations.
    assert.equal(channelOf(reasoningDeltas[0] as AgentEvent), 'reasoning');
    assert.equal(channelOf(contentDeltas[0] as AgentEvent), 'content');
  } finally {
    await server.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Multi-step ReAct                                                           */
/* -------------------------------------------------------------------------- */

test('runs a full reason -> act -> observe -> answer cycle', async () => {
  const server = await scriptedServer([
    {
      responseId: 'resp_step1',
      reasoning: ['I need to compute (17*3+4)/5.'],
      content: ['Let me calculate that.'],
      toolCalls: [
        { name: 'calculator', args: { expression: '(17*3+4)/5' }, argChunkSize: 5 },
      ],
      usage: { input_tokens: 20, output_tokens: 10 },
    },
    {
      responseId: 'resp_step2',
      reasoning: ['The tool returned 11.'],
      content: ['The answer is 11.'],
      usage: { input_tokens: 30, output_tokens: 8, reasoning_tokens: 3 },
    },
  ]);

  try {
    const agent = makeAgent(server.url, { tools: builtinTools() });
    const events = await collect(agent, 'What is (17*3+4)/5?');

    // All four content-bearing channels are exercised.
    const used = channelsUsed(events);
    for (const channel of ['reasoning', 'content', 'tool_call', 'tool_result', 'status'] as const) {
      assert.ok(used.has(channel), `expected the ${channel} channel to be used`);
    }

    // Two steps, each with its own streaming turn.
    assert.equal(events.filter((event) => event.type === 'step_start').length, 2);

    const toolCall = events.find((event) => event.type === 'tool_call');
    assert.ok(toolCall !== undefined);
    if (toolCall.type === 'tool_call') {
      assert.equal(toolCall.name, 'calculator');
      assert.deepEqual(toolCall.args, { expression: '(17*3+4)/5' });
      // Argument JSON streams in pieces before the call is complete.
      const deltas = events.filter(
        (event) => event.type === 'tool_call_delta' && event.argsDelta.length > 0,
      );
      assert.ok(deltas.length > 1, 'arguments should have arrived in several chunks');
    }

    const toolResult = events.find((event) => event.type === 'tool_result');
    assert.ok(toolResult !== undefined);
    if (toolResult.type === 'tool_result') {
      assert.equal(toolResult.ok, true);
      assert.equal(toolResult.name, 'calculator');
      assert.deepEqual(JSON.parse(toolResult.output), { expression: '(17*3+4)/5', result: 11 });
    }

    const runEnd = events.at(-1);
    assert.equal(runEnd?.type, 'run_end');
    if (runEnd?.type === 'run_end') {
      assert.equal(runEnd.stopReason, 'completed');
      assert.equal(runEnd.text, 'The answer is 11.');
      assert.equal(runEnd.steps, 2);
      assert.equal(runEnd.usage.input_tokens, 50);
      assert.equal(runEnd.usage.output_tokens, 18);
      assert.equal(runEnd.usage.total_tokens, 68);
      assert.equal(runEnd.usage.output_tokens_details?.reasoning_tokens, 3);
    }

    // The observation must be fed back on the second request.
    const secondInput = server.requests[1]?.body?.input as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(secondInput));

    const echoedCall = secondInput.find((item) => item.type === 'function_call');
    assert.ok(echoedCall !== undefined, 'the function_call item must be replayed');
    assert.equal(echoedCall.call_id, 'call_mock_1');
    assert.equal(echoedCall.name, 'calculator');
    assert.equal(echoedCall.arguments, '{"expression":"(17*3+4)/5"}');

    const observation = secondInput.find((item) => item.type === 'function_call_output');
    assert.ok(observation !== undefined, 'the observation must be replayed');
    assert.equal(observation.call_id, 'call_mock_1');
    assert.deepEqual(JSON.parse(observation.output as string), {
      expression: '(17*3+4)/5',
      result: 11,
    });

    // The assistant's own message is echoed to keep the transcript coherent.
    const echoedMessage = secondInput.find((item) => item.type === 'message' && item.role === 'assistant');
    assert.ok(echoedMessage !== undefined);
  } finally {
    await server.close();
  }
});

test('aggregates the full result from run()', async () => {
  const server = await scriptedServer([
    {
      reasoning: ['compute first'],
      toolCalls: [{ name: 'calculator', args: { expression: '6*7' } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    { reasoning: ['now answer'], content: ['42'], usage: { input_tokens: 15, output_tokens: 2 } },
  ]);

  try {
    const agent = makeAgent(server.url, { tools: [calculatorTool] });
    const result: AgentResult = await agent.run('six times seven?');

    assert.equal(result.text, '42');
    assert.equal(result.reasoningText, 'compute first\n\nnow answer');
    assert.deepEqual(
      result.reasoning.map((block) => block.part),
      ['summary', 'summary'],
    );
    assert.equal(result.steps.length, 2);
    assert.equal(result.stopReason, 'completed');
    assert.deepEqual(result.responseIds, ['resp_mock_1', 'resp_mock_1']);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolResults.length, 1);
    assert.equal(result.toolResults[0]?.ok, true);
    assert.deepEqual(JSON.parse(result.toolResults[0]?.output ?? 'null'), {
      expression: '6*7',
      result: 42,
    });
    assert.equal(result.usage.input_tokens, 25);
    assert.equal(result.usage.output_tokens, 7);
    assert.equal(result.error, undefined);
    assert.ok(result.durationMs >= 0);

    // The transcript starts with the user turn and ends with the observation.
    assert.equal(result.messages[0]?.type, 'message');
    assert.ok(result.messages.some((item) => item.type === 'function_call_output'));
  } finally {
    await server.close();
  }
});

test('runWithCallbacks routes each kind of output to its own handler', async () => {
  const server = await scriptedServer([
    {
      reasoning: ['thinking hard'],
      content: ['let me check '],
      toolCalls: [{ name: 'calculator', args: { expression: '2+2' }, argChunkSize: 4 }],
    },
    { content: ['done'] },
  ]);

  try {
    const agent = makeAgent(server.url, { tools: [calculatorTool] });

    const reasoning: string[] = [];
    const content: string[] = [];
    const calls: string[] = [];
    const results: string[] = [];
    const statuses: string[] = [];
    const argDeltas: string[] = [];

    const result = await agent.runWithCallbacks('go', {
      onReasoningDelta: (delta) => reasoning.push(delta),
      onContentDelta: (delta) => content.push(delta),
      onToolCall: (event) => calls.push(event.name),
      onToolCallDelta: (event) => {
        if (event.argsDelta.length > 0) argDeltas.push(event.argsDelta);
      },
      onToolResult: (event) => results.push(event.name),
      onStepStart: () => statuses.push('step'),
      onRunEnd: (event) => statuses.push(`end:${event.stopReason}`),
    });

    assert.deepEqual(reasoning, ['thinking hard']);
    assert.deepEqual(content, ['let me check ', 'done']);
    assert.deepEqual(calls, ['calculator']);
    assert.deepEqual(results, ['calculator']);
    assert.deepEqual(statuses, ['step', 'step', 'end:completed']);
    // Every argument chunk reaches the tool-call channel.
    assert.equal(argDeltas.join(''), '{"expression":"2+2"}');
    assert.equal(result.text, 'done');
  } finally {
    await server.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Tool failure handling                                                      */
/* -------------------------------------------------------------------------- */

test('feeds an unknown-tool error back and lets the model recover', async () => {
  const server = await scriptedServer([
    { toolCalls: [{ name: 'does_not_exist', args: { a: 1 } }] },
    { content: ['Sorry, I cannot do that.'] },
  ]);

  try {
    const agent = makeAgent(server.url, { tools: [calculatorTool] });
    const result = await agent.run('do the impossible');

    assert.equal(result.stopReason, 'completed');
    assert.equal(result.toolResults[0]?.ok, false);
    assert.match(result.toolResults[0]?.error ?? '', /Unknown tool "does_not_exist"/);

    const observation = result.messages.find((item) => item.type === 'function_call_output');
    assert.ok(observation !== undefined);
    if (observation.type === 'function_call_output') {
      assert.match(observation.output, /Unknown tool/);
    }
  } finally {
    await server.close();
  }
});

test('feeds a thrown tool error back as an observation', async () => {
  const server = await scriptedServer([
    { toolCalls: [{ name: 'calculator', args: { expression: '1/0' } }] },
    { content: ['Division by zero is undefined.'] },
  ]);

  try {
    const agent = makeAgent(server.url, { tools: [calculatorTool] });
    const result = await agent.run('compute 1/0');

    assert.equal(result.toolResults[0]?.ok, false);
    assert.match(result.toolResults[0]?.error ?? '', /Division by zero/);
    assert.equal(result.stopReason, 'completed');
  } finally {
    await server.close();
  }
});

test('feeds malformed tool arguments back instead of executing the tool', async () => {
  let executed = false;
  const spy = defineTool({
    name: 'spy',
    description: '',
    parameters: { type: 'object', properties: {} },
    execute: () => {
      executed = true;
      return 'ran';
    },
  });

  const server = await scriptedServer([
    { toolCalls: [{ name: 'spy', argumentsJson: '{"broken":' }] },
    { content: ['I will retry with valid JSON.'] },
  ]);

  try {
    const agent = makeAgent(server.url, { tools: [spy] });
    const result = await agent.run('go');

    assert.equal(executed, false, 'a tool with unparseable arguments must not run');
    assert.equal(result.toolResults[0]?.ok, false);
    assert.match(result.toolResults[0]?.error ?? '', /Could not parse arguments/);
  } finally {
    await server.close();
  }
});

test('rejects schema-violating arguments before running the tool', async () => {
  const server = await scriptedServer([
    { toolCalls: [{ name: 'calculator', args: { wrong: 'shape' } }] },
    { content: ['ok'] },
  ]);

  try {
    const agent = makeAgent(server.url, { tools: [calculatorTool] });
    const result = await agent.run('go');

    assert.equal(result.toolResults[0]?.ok, false);
    assert.match(result.toolResults[0]?.error ?? '', /required property is missing/);
  } finally {
    await server.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Parallel tool calls                                                        */
/* -------------------------------------------------------------------------- */

/** Two tools that only resolve once both have started. */
function barrierTools(): { tools: ReturnType<typeof defineTool>[]; reset: () => void } {
  let started = 0;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  const make = (name: string) =>
    defineTool({
      name,
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        started += 1;
        if (started === 2) release?.();
        // Deadlocks unless both calls are genuinely in flight at once.
        await barrier;
        return `${name} finished`;
      },
    });

  return { tools: [make('alpha'), make('beta')], reset: () => { started = 0; } };
}

test('runs tool calls concurrently when parallelToolCalls is enabled', async () => {
  const { tools } = barrierTools();
  const server = await scriptedServer([
    { toolCalls: [{ name: 'alpha', args: {} }, { name: 'beta', args: {} }] },
    { content: ['both done'] },
  ]);

  try {
    const agent = makeAgent(server.url, { tools, parallelToolCalls: true, toolTimeoutMs: 2000 });
    const result = await agent.run('go');

    assert.equal(result.toolResults.length, 2);
    // Both succeed only if they overlapped; a sequential loop would time out.
    assert.equal(result.toolResults[0]?.ok, true, result.toolResults[0]?.error);
    assert.equal(result.toolResults[1]?.ok, true, result.toolResults[1]?.error);
    // Results stay in the order the model requested them.
    assert.deepEqual(
      result.toolResults.map((entry) => entry.name),
      ['alpha', 'beta'],
    );
  } finally {
    await server.close();
  }
});

test('runs tool calls one at a time by default', async () => {
  const order: string[] = [];
  const first = defineTool({
    name: 'first',
    description: '',
    parameters: {},
    execute: async () => {
      order.push('first:start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('first:end');
      return 'a';
    },
  });
  const second = defineTool({
    name: 'second',
    description: '',
    parameters: {},
    execute: () => {
      order.push('second:start');
      order.push('second:end');
      return 'b';
    },
  });

  const server = await scriptedServer([
    { toolCalls: [{ name: 'first', args: {} }, { name: 'second', args: {} }] },
    { content: ['ok'] },
  ]);

  try {
    const agent = makeAgent(server.url, { tools: [first, second], parallelToolCalls: false });
    await agent.run('go');

    assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);
  } finally {
    await server.close();
  }
});

test('shares state between steps through a stateful tool', async () => {
  const server = await scriptedServer([
    { toolCalls: [{ name: 'memory', args: { action: 'set', key: 'answer', value: '42' } }] },
    { toolCalls: [{ name: 'memory', args: { action: 'get', key: 'answer' } }] },
    { content: ['The value is 42.'] },
  ]);

  try {
    const agent = makeAgent(server.url, { tools: [createMemoryTool()] });
    const result = await agent.run('remember 42 then read it back');

    assert.equal(result.steps.length, 3);
    assert.equal(result.toolResults.length, 2);
    assert.deepEqual(JSON.parse(result.toolResults[1]?.output ?? 'null'), {
      key: 'answer',
      found: true,
      value: '42',
    });
  } finally {
    await server.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Limits, abort and errors                                                   */
/* -------------------------------------------------------------------------- */

test('stops at maxSteps when the model keeps calling tools', async () => {
  const server = await scriptedServer([
    { toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }] },
  ]);

  try {
    const agent = makeAgent(server.url, { tools: [calculatorTool], maxSteps: 2 });
    const events = await collect(agent, 'loop forever');

    const runEnd = events.at(-1);
    assert.equal(runEnd?.type, 'run_end');
    if (runEnd?.type === 'run_end') {
      assert.equal(runEnd.stopReason, 'max_steps');
      assert.equal(runEnd.steps, 2);
    }
    assert.equal(server.requests.length, 2, 'must not exceed maxSteps model calls');
    assert.equal(events.filter((event) => event.type === 'step_start').length, 2);
  } finally {
    await server.close();
  }
});

test('a per-run maxSteps override wins', async () => {
  const server = await scriptedServer([
    { toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }] },
  ]);

  try {
    const agent = makeAgent(server.url, { tools: [calculatorTool], maxSteps: 9 });
    const result = await agent.run('go', { maxSteps: 1 });

    assert.equal(result.stopReason, 'max_steps');
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('an abort signal ends the run as aborted', async () => {
  const server = await startMockResponsesServer(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { events: buildTurn({ content: ['too late'] }) };
  });

  try {
    const agent = makeAgent(server.url);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const events: AgentEvent[] = [];
    for await (const event of agent.stream('go', { signal: controller.signal })) {
      events.push(event);
    }

    const error = events.find((event) => event.type === 'error');
    assert.ok(error !== undefined);

    const runEnd = events.at(-1);
    assert.equal(runEnd?.type, 'run_end');
    if (runEnd?.type === 'run_end') {
      assert.equal(runEnd.stopReason, 'aborted');
    }
  } finally {
    await server.close();
  }
});

test('an abort before the first step produces nothing but a clean end', async () => {
  const server = await scriptedServer([{ content: ['never sent'] }]);

  try {
    const agent = makeAgent(server.url);
    const controller = new AbortController();
    controller.abort();

    const result = await agent.run('go', { signal: controller.signal });
    assert.equal(result.stopReason, 'aborted');
    assert.equal(result.steps.length, 0);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('reports an API failure as an error event and a failed run', async () => {
  const server = await startMockResponsesServer(() => ({
    status: 400,
    json: { error: { message: 'Unsupported model', code: 'model_not_found' } },
  }));

  try {
    const agent = makeAgent(server.url);
    const events = await collect(agent, 'go');

    const error = events.find((event) => event.type === 'error');
    assert.ok(error !== undefined);
    if (error.type === 'error') {
      assert.equal(error.message, 'Unsupported model');
      assert.equal(error.code, 'model_not_found');
      assert.equal(error.fatal, true);
      assert.equal(error.retryable, false);
    }

    const runEnd = events.at(-1);
    if (runEnd?.type === 'run_end') {
      assert.equal(runEnd.stopReason, 'failed');
      assert.equal(runEnd.error, 'Unsupported model');
    }
  } finally {
    await server.close();
  }
});

test('throwOnError rethrows the API error', async () => {
  const server = await startMockResponsesServer(() => ({
    status: 401,
    json: { error: { message: 'bad key', code: 'invalid_api_key' } },
  }));

  try {
    const agent = makeAgent(server.url, { throwOnError: true });
    await assert.rejects(
      () => agent.run('go'),
      (error: unknown) => {
        assert.ok(error instanceof OpenAIError);
        assert.equal(error.status, 401);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('reports a failed model response with its error message', async () => {
  const server = await scriptedServer([
    { status: 'failed', error: { message: 'the model refused to continue', code: 'server_error' } },
  ]);

  try {
    const agent = makeAgent(server.url);
    const result = await agent.run('go');

    assert.equal(result.stopReason, 'failed');
    assert.equal(result.error, 'the model refused to continue');
  } finally {
    await server.close();
  }
});

test('handles a truncated stream that never sends response.completed', async () => {
  const server = await scriptedServer([
    { reasoning: ['partial'], content: ['incomplete answer'], omitCompleted: true },
  ]);

  try {
    const agent = makeAgent(server.url);
    const result = await agent.run('go');

    // Output produced before the stream ended is still delivered.
    assert.equal(result.text, 'incomplete answer');
    assert.equal(result.reasoningText, 'partial');
    assert.equal(result.stopReason, 'completed');
  } finally {
    await server.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Request shaping                                                            */
/* -------------------------------------------------------------------------- */

test('sends tools, instructions, reasoning and store settings', async () => {
  const server = await scriptedServer([{ content: ['ok'] }]);

  try {
    const agent = makeAgent(server.url, {
      tools: [calculatorTool],
      instructions: 'You are terse.',
      reasoning: { effort: 'low', summary: 'auto' },
      temperature: 0.2,
      maxOutputTokens: 256,
      store: false,
    });
    await agent.run('go');

    const body = server.requests[0]?.body;
    assert.ok(body !== undefined);
    assert.equal(body.instructions, 'You are terse.');
    assert.deepEqual(body.reasoning, { effort: 'low', summary: 'auto' });
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_output_tokens, 256);
    assert.equal(body.store, false);
    assert.equal(body.parallel_tool_calls, false);

    const tools = body.tools as Array<Record<string, unknown>>;
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.type, 'function');
    assert.equal(tools[0]?.name, 'calculator');
  } finally {
    await server.close();
  }
});

test('omits tools entirely when none are registered', async () => {
  const server = await scriptedServer([{ content: ['ok'] }]);

  try {
    const agent = makeAgent(server.url);
    await agent.run('go');

    const body = server.requests[0]?.body;
    assert.equal(body?.tools, undefined);
    assert.equal(body?.tool_choice, undefined);
  } finally {
    await server.close();
  }
});

test('adds the encrypted-reasoning include when echoing reasoning items', async () => {
  const server = await scriptedServer([{ reasoning: ['think'], content: ['answer'] }]);

  try {
    const agent = makeAgent(server.url, { echoReasoningItems: true, store: false });
    await agent.run('go');
    assert.deepEqual(server.requests[0]?.body?.include, ['reasoning.encrypted_content']);
  } finally {
    await server.close();
  }
});

test('echoAssistantMessages can be turned off', async () => {
  const server = await scriptedServer([
    { content: ['first'], toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }] },
    { content: ['second'] },
  ]);

  try {
    const agent = makeAgent(server.url, { tools: [calculatorTool], echoAssistantMessages: false });
    await agent.run('go');

    const secondInput = server.requests[1]?.body?.input as Array<Record<string, unknown>>;
    assert.equal(
      secondInput.some((item) => item.type === 'message' && item.role === 'assistant'),
      false,
    );
    // The tool call and its observation are still replayed.
    assert.equal(secondInput.some((item) => item.type === 'function_call'), true);
    assert.equal(secondInput.some((item) => item.type === 'function_call_output'), true);
  } finally {
    await server.close();
  }
});

test('run_start exposes the model, tools and input', async () => {
  const server = await scriptedServer([{ content: ['ok'] }]);

  try {
    const agent = makeAgent(server.url, { tools: builtinTools(), maxSteps: 4 });
    const events = await collect(agent, 'say hello');

    const runStart = events[0];
    assert.equal(runStart?.type, 'run_start');
    if (runStart?.type === 'run_start') {
      assert.equal(runStart.model, 'gpt-mock');
      assert.deepEqual(runStart.tools.sort(), ['calculator', 'current_time', 'memory']);
      assert.equal(runStart.maxSteps, 4);
      assert.equal(runStart.input, 'say hello');
    }
  } finally {
    await server.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Input normalisation                                                        */
/* -------------------------------------------------------------------------- */

test('normalizeInput accepts the documented shapes', () => {
  assert.deepEqual(normalizeInput('hello'), [userMessage('hello')]);
  assert.deepEqual(normalizeInput(['a', 'b']), [userMessage('a'), userMessage('b')]);
  assert.deepEqual(normalizeInput([]), []);

  const items = [userMessage('one'), assistantMessage('two')];
  assert.deepEqual(normalizeInput(items), items);
  assert.deepEqual(normalizeInput(userMessage('single')), [userMessage('single')]);
});

test('a run can continue an existing transcript', async () => {
  const server = await scriptedServer([{ content: ['carrying on'] }]);

  try {
    const agent = makeAgent(server.url);
    const result = await agent.run([
      userMessage('first question'),
      assistantMessage('first answer'),
      userMessage('second question'),
    ]);

    const input = server.requests[0]?.body?.input as Array<Record<string, unknown>>;
    assert.equal(input.length, 3);
    assert.equal(input[0]?.role, 'user');
    assert.equal(input[1]?.role, 'assistant');
    assert.equal(input[2]?.role, 'user');
    assert.equal(result.text, 'carrying on');
  } finally {
    await server.close();
  }
});
