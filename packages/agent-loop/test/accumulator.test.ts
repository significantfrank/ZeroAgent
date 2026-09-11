import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TurnAccumulator, parseToolArguments } from '../src/agent/accumulator.ts';
import { channelOf } from '../src/agent/events.ts';
import type { AgentEvent } from '../src/agent/events.ts';
import type { ResponseStreamEvent } from '../src/openai/types.ts';
import { buildTurn } from './helpers/responses-script.ts';
import type { TurnSpec } from './helpers/responses-script.ts';

interface Harness {
  events: AgentEvent[];
  accumulator: TurnAccumulator;
  /** Events on a single channel, in order. */
  on(channel: string): AgentEvent[];
  /** Events of one type, correctly narrowed. */
  filter<T extends AgentEvent['type']>(type: T): Array<Extract<AgentEvent, { type: T }>>;
  types(): string[];
}

function drive(spec: TurnSpec, options: { finalize?: boolean } = {}): Harness {
  const accumulator = new TurnAccumulator(1);
  const events: AgentEvent[] = [];

  for (const raw of buildTurn(spec)) {
    for (const event of accumulator.consume(raw as ResponseStreamEvent)) {
      events.push(event);
    }
  }
  if (options.finalize !== false) {
    for (const event of accumulator.finalize()) events.push(event);
  }

  return {
    events,
    accumulator,
    on(channel) {
      return events.filter((event) => channelOf(event) === channel);
    },
    filter<T extends AgentEvent['type']>(type: T): Array<Extract<AgentEvent, { type: T }>> {
      return events.filter(
        (event): event is Extract<AgentEvent, { type: T }> => event.type === type,
      );
    },
    types() {
      return events.map((event) => event.type);
    },
  };
}

test('routes reasoning, content and tool calls onto separate channels', () => {
  const harness = drive({
    reasoning: ['I should ', 'compute this.'],
    content: ['The answer ', 'is 4.'],
    toolCalls: [{ name: 'calculator', args: { expression: '2+2' }, argChunkSize: 4 }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });

  const reasoning = harness.on('reasoning');
  const content = harness.on('content');
  const toolCalls = harness.on('tool_call');

  assert.ok(reasoning.length > 0, 'expected reasoning events');
  assert.ok(content.length > 0, 'expected content events');
  assert.ok(toolCalls.length > 0, 'expected tool-call events');

  // No event may belong to more than one channel.
  for (const event of harness.events) {
    assert.ok(channelOf(event).length > 0, `unclassified event ${event.type}`);
  }

  // Reasoning deltas must never carry answer text, and vice versa.
  const reasoningText = reasoning
    .filter((event) => event.type === 'reasoning_delta')
    .map((event) => event.delta)
    .join('');
  const contentText = content
    .filter((event) => event.type === 'content_delta')
    .map((event) => event.delta)
    .join('');

  assert.equal(reasoningText, 'I should compute this.');
  assert.equal(contentText, 'The answer is 4.');
});

test('accumulates reasoning deltas and reports the part kind', () => {
  const harness = drive({ reasoning: ['step ', 'one'] });
  const deltas = harness.events.filter((event) => event.type === 'reasoning_delta');

  assert.equal(deltas.length, 2);
  assert.equal(deltas[0]?.delta, 'step ');
  assert.equal(deltas[0]?.text, 'step ', 'text field is the running total');
  assert.equal(deltas[1]?.text, 'step one');
  assert.equal(deltas[0]?.part, 'summary');

  const done = harness.events.find((event) => event.type === 'reasoning_done');
  assert.ok(done !== undefined);
  assert.equal(done.text, 'step one');
});

test('distinguishes raw reasoning text from the reasoning summary', () => {
  const harness = drive({ reasoning: ['summary'], reasoningText: ['raw chain'] });
  const deltas = harness.filter('reasoning_delta');

  assert.equal(deltas.find((event) => event.part === 'summary')?.delta, 'summary');
  assert.equal(deltas.find((event) => event.part === 'text')?.delta, 'raw chain');
});

test('accumulates content deltas into a running total', () => {
  const harness = drive({ content: ['Hello', ', ', 'world'] });
  const deltas = harness.events.filter((event) => event.type === 'content_delta');

  assert.deepEqual(
    deltas.map((event) => event.delta),
    ['Hello', ', ', 'world'],
  );
  assert.equal(deltas[2]?.text, 'Hello, world');
  assert.equal(harness.accumulator.snapshot().text, 'Hello, world');
});

test('keeps a refusal separate from the answer text', () => {
  const harness = drive({ content: ['partial'], refusal: ["I can't help with that."] });
  const snapshot = harness.accumulator.snapshot();

  assert.equal(snapshot.text, 'partial');
  assert.equal(snapshot.refusal, "I can't help with that.");

  const refusalDeltas = harness.events.filter((event) => event.type === 'refusal_delta');
  assert.equal(refusalDeltas.length, 1);
  assert.equal(channelOf(refusalDeltas[0] as AgentEvent), 'content');
});

test('emits one parsed tool_call event and streams its arguments incrementally', () => {
  const harness = drive({
    toolCalls: [{ name: 'calculator', args: { expression: '2+2' }, argChunkSize: 3 }],
  });

  const deltas = harness.events.filter((event) => event.type === 'tool_call_delta');
  // The first delta opens the call with the tool name and no arguments yet.
  assert.equal(deltas[0]?.argsDelta, '');
  assert.equal(deltas[0]?.name, 'calculator');

  const streamed = deltas
    .filter((event) => event.argsDelta.length > 0)
    .map((event) => event.argsDelta)
    .join('');
  assert.equal(streamed, '{"expression":"2+2"}');

  const calls = harness.events.filter((event) => event.type === 'tool_call');
  assert.equal(calls.length, 1, 'exactly one completed tool_call event');
  assert.equal(calls[0]?.name, 'calculator');
  assert.equal(calls[0]?.callId, 'call_mock_1');
  assert.deepEqual(calls[0]?.args, { expression: '2+2' });
  assert.equal(calls[0]?.parseError, undefined);
});

test('records several tool calls in request order', () => {
  const harness = drive({
    toolCalls: [
      { name: 'first', args: { a: 1 } },
      { name: 'second', args: { b: 2 } },
      { name: 'third', args: { c: 3 } },
    ],
  });

  const calls = harness.events.filter((event) => event.type === 'tool_call');
  assert.deepEqual(
    calls.map((event) => event.name),
    ['first', 'second', 'third'],
  );
  assert.deepEqual(harness.accumulator.toolCalls.map((call) => call.name), ['first', 'second', 'third']);
});

test('reports malformed tool arguments without throwing', () => {
  const harness = drive({
    toolCalls: [{ name: 'calculator', argumentsJson: '{"expression": ' }],
  });

  const call = harness.events.find((event) => event.type === 'tool_call');
  assert.ok(call !== undefined);
  assert.equal(call.args, undefined);
  assert.match(call.parseError ?? '', /not valid JSON/);
});

test('treats a non-object argument payload as a parse error', () => {
  const harness = drive({ toolCalls: [{ name: 'calculator', argumentsJson: '"just a string"' }] });
  const call = harness.events.find((event) => event.type === 'tool_call');
  assert.match(call?.parseError ?? '', /must be a JSON object/);
});

test('treats an empty argument string as an empty object', () => {
  assert.deepEqual(parseToolArguments(''), { args: {}, error: undefined });
  assert.deepEqual(parseToolArguments('   '), { args: {}, error: undefined });

  const harness = drive({ toolCalls: [{ name: 'noargs', argumentsJson: '' }] });
  const call = harness.events.find((event) => event.type === 'tool_call');
  assert.deepEqual(call?.args, {});
  assert.equal(call?.parseError, undefined);
});

test('still completes tool calls when the *_done events are missing', () => {
  const harness = drive({
    toolCalls: [
      {
        name: 'calculator',
        args: { expression: '1+1' },
        argChunkSize: 2,
      },
    ],
    omitArgumentsDone: true,
    omitItemDone: true,
  });

  const call = harness.events.find((event) => event.type === 'tool_call');
  assert.ok(call !== undefined, 'the item-done event should finalise the call');
  assert.deepEqual(call.args, { expression: '1+1' });
  assert.equal(harness.accumulator.toolCalls.length, 1);
});

test('finalizes reasoning and content when only deltas were sent', () => {
  const harness = drive(
    { reasoning: ['think'], content: ['say'], omitReasoningDone: true, omitItemDone: true },
  );

  assert.equal(harness.events.filter((event) => event.type === 'reasoning_done').length, 1);
  assert.equal(harness.events.filter((event) => event.type === 'content_done').length, 1);
});

test('recovers the full turn from response.completed when item events were missed', () => {
  const harness = drive({
    reasoning: ['why'],
    content: ['because'],
    toolCalls: [{ name: 'calculator', args: { expression: '9*9' } }],
    omitCompleted: true,
  });

  // Without response.completed the status is still in_progress...
  assert.equal(harness.accumulator.snapshot().status, 'in_progress');
  // ...but every piece of output is still accounted for.
  const snapshot = harness.accumulator.snapshot();
  assert.equal(snapshot.text, 'because');
  assert.equal(snapshot.reasoningText, 'why');
  assert.equal(snapshot.toolCalls.length, 1);
});

test('adopts text from response.output when nothing was streamed', () => {
  // Some gateways (and non-streaming-ish paths) deliver content only in the
  // terminal resource. The accumulator must still report the full turn.
  const accumulator = new TurnAccumulator(1);
  const events: AgentEvent[] = [];

  for (const event of accumulator.consume({
    type: 'response.completed',
    response: {
      id: 'resp_1',
      model: 'gpt-mock',
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'thought' }] },
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'final answer' }],
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'calculator',
          arguments: '{"expression":"1+1"}',
        },
      ],
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
    },
  })) {
    events.push(event);
  }

  const snapshot = accumulator.snapshot();
  assert.equal(snapshot.text, 'final answer');
  assert.equal(snapshot.reasoningText, 'thought');
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.usage?.total_tokens, 7);

  assert.equal(snapshot.toolCalls.length, 1);
  assert.equal(snapshot.toolCalls[0]?.name, 'calculator');
  assert.deepEqual(snapshot.toolCalls[0]?.args, { expression: '1+1' });

  assert.ok(events.some((event) => event.type === 'content_done'));
  assert.ok(events.some((event) => event.type === 'reasoning_done'));
  assert.ok(events.some((event) => event.type === 'tool_call'));
});

test('adopting response.output never duplicates already-streamed events', () => {
  const harness = drive({ reasoning: ['r'], content: ['c'] });
  const before = harness.events.length;
  const extra = harness.accumulator.finalize();
  assert.deepEqual(extra, []);
  assert.equal(harness.events.length, before);
});

test('finalize is idempotent', () => {
  const accumulator = new TurnAccumulator(1);
  for (const raw of buildTurn({ content: ['hi'] })) {
    accumulator.consume(raw as ResponseStreamEvent);
  }
  const first = accumulator.finalize();
  const second = accumulator.finalize();
  assert.ok(first.length >= 0);
  assert.deepEqual(second, []);
});

test('handles deltas that arrive without an output_item.added event', () => {
  const accumulator = new TurnAccumulator(1);
  const events = accumulator.consume({
    type: 'response.output_text.delta',
    item_id: 'msg_unannounced',
    output_index: 0,
    content_index: 0,
    delta: 'orphan',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'content_delta');
  assert.equal(accumulator.snapshot().text, 'orphan');
});

test('ignores output item types it does not model', () => {
  const accumulator = new TurnAccumulator(1);
  const added = accumulator.consume({
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' },
  });
  assert.deepEqual(added, []);
  assert.deepEqual(accumulator.finalize(), []);
});

test('captures usage, response id and status from the terminal event', () => {
  const harness = drive({
    responseId: 'resp_abc',
    content: ['done'],
    usage: { input_tokens: 12, output_tokens: 34, reasoning_tokens: 7 },
  });
  const snapshot = harness.accumulator.snapshot();

  assert.equal(snapshot.responseId, 'resp_abc');
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.usage?.input_tokens, 12);
  assert.equal(snapshot.usage?.output_tokens, 34);
  assert.equal(snapshot.usage?.output_tokens_details?.reasoning_tokens, 7);
  assert.equal(snapshot.usage?.total_tokens, 46);
});

test('surfaces a failed response as an error event', () => {
  const harness = drive({
    status: 'failed',
    error: { message: 'model overloaded', code: 'overloaded' },
  });

  const error = harness.events.find((event) => event.type === 'error');
  assert.ok(error !== undefined);
  assert.equal(error.message, 'model overloaded');
  assert.equal(error.code, 'overloaded');
  assert.equal(error.fatal, true);
  assert.equal(harness.accumulator.snapshot().status, 'failed');
});

test('maps a mid-stream error frame to a fatal error event', () => {
  const accumulator = new TurnAccumulator(3);
  const events = accumulator.consume({
    type: 'error',
    code: 'server_error',
    message: 'upstream exploded',
  });

  assert.equal(events.length, 1);
  const error = events[0];
  assert.equal(error?.type, 'error');
  if (error?.type === 'error') {
    assert.equal(error.step, 3);
    assert.equal(error.message, 'upstream exploded');
    assert.equal(error.fatal, true);
  }
});

test('reports an incomplete response without raising an error', () => {
  const harness = drive({ content: ['partial answer'], status: 'incomplete' });
  assert.equal(harness.accumulator.snapshot().status, 'incomplete');
  assert.equal(harness.events.some((event) => event.type === 'error'), false);
});

test('builds function_call items for the next request', () => {
  const harness = drive({
    reasoning: ['think'],
    content: ['let me check'],
    toolCalls: [{ name: 'calculator', args: { expression: '3*3' } }],
  });
  const items = harness.accumulator.snapshot().outputItems;

  const call = items.find((item) => item.type === 'function_call');
  assert.ok(call !== undefined);
  if (call.type === 'function_call') {
    assert.equal(call.call_id, 'call_mock_1');
    assert.equal(call.name, 'calculator');
    assert.equal(call.arguments, '{"expression":"3*3"}');
  }

  const message = items.find((item) => item.type === 'message');
  assert.ok(message !== undefined);

  // Reasoning items are never echoed as output items by the accumulator.
  assert.equal(items.some((item) => item.type === 'reasoning'), false);
});

test('falls back to the item id when call_id is absent', () => {
  const accumulator = new TurnAccumulator(1);
  for (const event of [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_no_call_id', name: 'lonely', arguments: '' },
    },
    {
      type: 'response.function_call_arguments.done',
      item_id: 'fc_no_call_id',
      output_index: 0,
      arguments: '{}',
    },
  ] as ResponseStreamEvent[]) {
    accumulator.consume(event);
  }

  const call = accumulator.toolCalls[0];
  assert.equal(call?.callId, 'fc_no_call_id');
  assert.equal(call?.name, 'lonely');
});

test('ignores a function call that never carries a name', () => {
  const accumulator = new TurnAccumulator(1);
  accumulator.consume({
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'function_call', id: 'fc_x', call_id: 'call_x', name: '', arguments: '' },
  });
  const events = accumulator.finalize();
  assert.equal(events.some((event) => event.type === 'tool_call'), false);
});
