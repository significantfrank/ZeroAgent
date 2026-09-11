import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addUsage,
  channelOf,
  displayText,
  emptyUsage,
  isContentEvent,
  isReasoningEvent,
  isToolCallEvent,
} from '../src/agent/events.ts';
import type { AgentEvent, AgentEventType } from '../src/agent/events.ts';

/** Compile-time proof that every event type is handled. */
function describeEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'run_start':
      return `run_start(${event.model})`;
    case 'step_start':
      return `step_start(${event.step})`;
    case 'response_start':
      return `response_start(${event.step})`;
    case 'reasoning_delta':
      return `reasoning_delta(${event.part})`;
    case 'reasoning_done':
      return `reasoning_done(${event.part})`;
    case 'content_delta':
      return `content_delta(${event.delta})`;
    case 'content_done':
      return `content_done(${event.text})`;
    case 'refusal_delta':
      return `refusal_delta(${event.delta})`;
    case 'refusal_done':
      return `refusal_done(${event.text})`;
    case 'tool_call_delta':
      return `tool_call_delta(${event.name})`;
    case 'tool_call':
      return `tool_call(${event.name})`;
    case 'tool_result':
      return `tool_result(${event.name})`;
    case 'step_end':
      return `step_end(${event.step})`;
    case 'run_end':
      return `run_end(${event.stopReason})`;
    case 'error':
      return `error(${event.message})`;
    default: {
      // If a new event type is added without a case above, this stops compiling.
      const unreachable: never = event;
      return String(unreachable);
    }
  }
}

const ALL_EVENT_TYPES: AgentEventType[] = [
  'run_start',
  'step_start',
  'response_start',
  'reasoning_delta',
  'reasoning_done',
  'content_delta',
  'content_done',
  'refusal_delta',
  'refusal_done',
  'tool_call_delta',
  'tool_call',
  'tool_result',
  'step_end',
  'run_end',
  'error',
];

test('every declared event type is covered by the exhaustive switch', () => {
  const samples: Record<AgentEventType, AgentEvent> = {
    run_start: { type: 'run_start', model: 'm', tools: [], maxSteps: 3, input: 'hi' },
    step_start: { type: 'step_start', step: 1 },
    response_start: { type: 'response_start', step: 1 },
    reasoning_delta: {
      type: 'reasoning_delta',
      step: 1,
      itemId: 'rs',
      outputIndex: 0,
      part: 'summary',
      delta: 'a',
      text: 'a',
    },
    reasoning_done: {
      type: 'reasoning_done',
      step: 1,
      itemId: 'rs',
      outputIndex: 0,
      part: 'summary',
      text: 'a',
    },
    content_delta: { type: 'content_delta', step: 1, itemId: 'msg', outputIndex: 1, delta: 'b', text: 'b' },
    content_done: { type: 'content_done', step: 1, itemId: 'msg', outputIndex: 1, text: 'b' },
    refusal_delta: { type: 'refusal_delta', step: 1, itemId: 'msg', outputIndex: 1, delta: 'no', text: 'no' },
    refusal_done: { type: 'refusal_done', step: 1, itemId: 'msg', outputIndex: 1, text: 'no' },
    tool_call_delta: {
      type: 'tool_call_delta',
      step: 1,
      itemId: 'fc',
      outputIndex: 2,
      callId: 'call_1',
      name: 'calc',
      argsDelta: '{',
      arguments: '{',
    },
    tool_call: {
      type: 'tool_call',
      step: 1,
      itemId: 'fc',
      outputIndex: 2,
      callId: 'call_1',
      name: 'calc',
      arguments: '{}',
      args: {},
    },
    tool_result: {
      type: 'tool_result',
      step: 1,
      callId: 'call_1',
      name: 'calc',
      ok: true,
      output: '4',
      durationMs: 1,
    },
    step_end: {
      type: 'step_end',
      step: 1,
      status: 'completed',
      text: '',
      reasoning: '',
      toolCalls: [],
      toolResults: [],
      durationMs: 1,
    },
    run_end: {
      type: 'run_end',
      steps: 1,
      stopReason: 'completed',
      text: '',
      reasoning: '',
      usage: emptyUsage(),
      durationMs: 1,
    },
    error: { type: 'error', message: 'boom', fatal: true, retryable: false },
  };

  for (const type of ALL_EVENT_TYPES) {
    const event = samples[type];
    assert.equal(event.type, type);
    assert.equal(typeof describeEvent(event), 'string');
  }
});

test('channelOf separates reasoning, content and tool calls', () => {
  assert.equal(channelOf({ type: 'reasoning_delta', step: 1, itemId: 'r', outputIndex: 0, part: 'summary', delta: 'a', text: 'a' }), 'reasoning');
  assert.equal(channelOf({ type: 'reasoning_done', step: 1, itemId: 'r', outputIndex: 0, part: 'text', text: 'a' }), 'reasoning');

  assert.equal(channelOf({ type: 'content_delta', step: 1, itemId: 'm', outputIndex: 1, delta: 'a', text: 'a' }), 'content');
  assert.equal(channelOf({ type: 'content_done', step: 1, itemId: 'm', outputIndex: 1, text: 'a' }), 'content');
  // Refusals are assistant-visible text.
  assert.equal(channelOf({ type: 'refusal_delta', step: 1, itemId: 'm', outputIndex: 1, delta: 'a', text: 'a' }), 'content');

  assert.equal(
    channelOf({ type: 'tool_call_delta', step: 1, itemId: 'f', outputIndex: 2, callId: 'c', name: 'n', argsDelta: '', arguments: '' }),
    'tool_call',
  );
  assert.equal(
    channelOf({ type: 'tool_call', step: 1, itemId: 'f', outputIndex: 2, callId: 'c', name: 'n', arguments: '{}', args: {} }),
    'tool_call',
  );
  assert.equal(
    channelOf({ type: 'tool_result', step: 1, callId: 'c', name: 'n', ok: true, output: 'x', durationMs: 0 }),
    'tool_result',
  );

  assert.equal(channelOf({ type: 'step_start', step: 1 }), 'status');
  assert.equal(channelOf({ type: 'error', message: 'x', fatal: true, retryable: false }), 'error');
});

test('the three streamed channels never collapse into one', () => {
  const channels = new Set([
    channelOf({ type: 'reasoning_delta', step: 1, itemId: 'r', outputIndex: 0, part: 'summary', delta: 'a', text: 'a' }),
    channelOf({ type: 'content_delta', step: 1, itemId: 'm', outputIndex: 1, delta: 'a', text: 'a' }),
    channelOf({ type: 'tool_call_delta', step: 1, itemId: 'f', outputIndex: 2, callId: 'c', name: 'n', argsDelta: 'a', arguments: 'a' }),
  ]);
  assert.deepEqual([...channels].sort(), ['content', 'reasoning', 'tool_call']);
});

test('displayText returns only incremental text', () => {
  assert.equal(displayText({ type: 'reasoning_delta', step: 1, itemId: 'r', outputIndex: 0, part: 'summary', delta: 'think', text: 'think' }), 'think');
  assert.equal(displayText({ type: 'content_delta', step: 1, itemId: 'm', outputIndex: 1, delta: 'answer', text: 'answer' }), 'answer');
  assert.equal(displayText({ type: 'refusal_delta', step: 1, itemId: 'm', outputIndex: 1, delta: 'no', text: 'no' }), 'no');
  assert.equal(
    displayText({ type: 'tool_call_delta', step: 1, itemId: 'f', outputIndex: 2, callId: 'c', name: 'n', argsDelta: '{"a"', arguments: '{"a"' }),
    '{"a"',
  );
  // A tool call opening frame carries no new text.
  assert.equal(
    displayText({ type: 'tool_call_delta', step: 1, itemId: 'f', outputIndex: 2, callId: 'c', name: 'n', argsDelta: '', arguments: '' }),
    undefined,
  );
  // Lifecycle and completion events carry no incremental text.
  assert.equal(displayText({ type: 'step_start', step: 1 }), undefined);
  assert.equal(displayText({ type: 'reasoning_done', step: 1, itemId: 'r', outputIndex: 0, part: 'summary', text: 'x' }), undefined);
  assert.equal(displayText({ type: 'run_end', steps: 1, stopReason: 'completed', text: '', reasoning: '', usage: emptyUsage(), durationMs: 0 }), undefined);
});

test('type guards narrow the expected events', () => {
  const reasoning: AgentEvent = { type: 'reasoning_done', step: 1, itemId: 'r', outputIndex: 0, part: 'summary', text: 'x' };
  const content: AgentEvent = { type: 'content_done', step: 1, itemId: 'm', outputIndex: 1, text: 'y' };
  const toolCall: AgentEvent = { type: 'tool_call', step: 1, itemId: 'f', outputIndex: 2, callId: 'c', name: 'n', arguments: '{}', args: {} };

  assert.equal(isReasoningEvent(reasoning), true);
  assert.equal(isReasoningEvent(content), false);
  assert.equal(isContentEvent(content), true);
  assert.equal(isContentEvent(reasoning), false);
  assert.equal(isToolCallEvent(toolCall), true);
  assert.equal(isToolCallEvent(content), false);
});

test('addUsage sums tokens and preserves detail sub-objects', () => {
  const total = addUsage(
    { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    {
      input_tokens: 5,
      output_tokens: 7,
      total_tokens: 12,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 4 },
    },
  );
  assert.equal(total.input_tokens, 15);
  assert.equal(total.output_tokens, 27);
  assert.equal(total.total_tokens, 42);
  assert.equal(total.input_tokens_details?.cached_tokens, 3);
  assert.equal(total.output_tokens_details?.reasoning_tokens, 4);
});

test('addUsage leaves detail sub-objects off when absent', () => {
  const total = addUsage(emptyUsage(), { input_tokens: 1, output_tokens: 2, total_tokens: 3 });
  assert.equal(total.input_tokens_details, undefined);
  assert.equal(total.output_tokens_details, undefined);
});

test('addUsage tolerates undefined', () => {
  const base = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
  assert.deepEqual(addUsage(base, undefined), base);
});
