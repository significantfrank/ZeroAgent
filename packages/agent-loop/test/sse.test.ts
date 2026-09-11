import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SSEParser, parseSSEStream } from '../src/openai/sse.ts';

test('parses a single data-only event', () => {
  const parser = new SSEParser();
  const messages = parser.push('data: hello\n\n');
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.data, 'hello');
  assert.equal(messages[0]?.event, undefined);
});

test('parses the event name and strips one leading space', () => {
  const parser = new SSEParser();
  const messages = parser.push('event: response.output_text.delta\ndata: {"delta":"hi"}\n\n');
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.event, 'response.output_text.delta');
  assert.equal(messages[0]?.data, '{"delta":"hi"}');
});

test('joins repeated data lines with a newline', () => {
  const parser = new SSEParser();
  const messages = parser.push('data: line one\ndata: line two\n\n');
  assert.equal(messages[0]?.data, 'line one\nline two');
});

test('keeps the value intact when there is no space after the colon', () => {
  const parser = new SSEParser();
  const messages = parser.push('data:{"a":1}\n\n');
  assert.equal(messages[0]?.data, '{"a":1}');
});

test('treats a field with no colon as an empty value', () => {
  const parser = new SSEParser();
  const messages = parser.push('data\n\n');
  // `data` with no colon sets an empty data line, so the data buffer stays
  // empty and, per spec, nothing is dispatched.
  assert.equal(messages.length, 0);

  const withText = new SSEParser();
  const populated = withText.push('data\n\ndata: real\n\n');
  assert.equal(populated.length, 1);
  assert.equal(populated[0]?.data, 'real');
});

test('ignores comment lines used as keep-alives', () => {
  const parser = new SSEParser();
  const messages = parser.push(': ping\n\n: another\n\n');
  assert.equal(messages.length, 0);
});

test('only strips a single leading space', () => {
  const parser = new SSEParser();
  const messages = parser.push('data:   two spaces\n\n');
  assert.equal(messages[0]?.data, '  two spaces');
});

test('parses retry as an integer and ignores a non-numeric value', () => {
  const parser = new SSEParser();
  const messages = parser.push('retry: 1500\ndata: x\n\n');
  assert.equal(messages[0]?.retry, 1500);

  const other = new SSEParser();
  const withBad = other.push('retry: soon\ndata: y\n\n');
  assert.equal(withBad[0]?.retry, undefined);
});

test('persists the last event id across messages', () => {
  const parser = new SSEParser();
  const first = parser.push('id: 42\ndata: a\n\n');
  assert.equal(first[0]?.id, '42');

  const second = parser.push('data: b\n\n');
  assert.equal(second[0]?.id, '42');
});

test('parses several events from one chunk', () => {
  const parser = new SSEParser();
  const messages = parser.push('data: one\n\ndata: two\n\ndata: three\n\n');
  assert.deepEqual(
    messages.map((m) => m.data),
    ['one', 'two', 'three'],
  );
});

test('buffers an incomplete line until the rest arrives', () => {
  const parser = new SSEParser();
  assert.deepEqual(parser.push('data: par'), []);
  // The line is complete now, but a line terminator is not a blank line: the
  // event must wait for the frame to actually end.
  assert.deepEqual(parser.push('tial\n'), []);
  const messages = parser.push('\n');
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.data, 'partial');
});

test('does not split a multi-line data event across chunks', () => {
  const parser = new SSEParser();
  // A chunk boundary that lands exactly on a line terminator must not be
  // mistaken for the blank line that ends the event.
  const first = parser.push('data: line one\n');
  const second = parser.push('data: line two\n\n');
  const messages = [...first, ...second];

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.data, 'line one\nline two');
});

test('handles every possible chunk split of a frame', () => {
  const frame = 'event: response.output_text.delta\ndata: {"delta":"你好"}\n\n';
  for (let split = 0; split <= frame.length; split += 1) {
    const parser = new SSEParser();
    const messages = [
      ...parser.push(frame.slice(0, split)),
      ...parser.push(frame.slice(split)),
      ...parser.end(),
    ];
    assert.equal(messages.length, 1, `split at ${split} produced ${messages.length} messages`);
    assert.equal(messages[0]?.data, '{"delta":"你好"}', `split at ${split}`);
    assert.equal(messages[0]?.event, 'response.output_text.delta', `split at ${split}`);
  }
});

test('handles a CRLF pair split across two chunks', () => {
  const parser = new SSEParser();
  const first = parser.push('data: value\r');
  const second = parser.push('\n\r\n');
  const messages = [...first, ...second];
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.data, 'value');
});

test('accepts bare CR line endings', () => {
  const parser = new SSEParser();
  const messages = parser.push('data: car\r\r');
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.data, 'car');
});

test('end() flushes an event that was never blank-line terminated', () => {
  const parser = new SSEParser();
  assert.deepEqual(parser.push('data: trailing'), []);
  const messages = parser.end();
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.data, 'trailing');
});

test('end() is a no-op when nothing is buffered', () => {
  const parser = new SSEParser();
  parser.push('data: done\n\n');
  assert.deepEqual(parser.end(), []);
});

test('reset() clears buffered state', () => {
  const parser = new SSEParser();
  parser.push('data: pending');
  parser.reset();
  assert.deepEqual(parser.end(), []);
});

function streamFrom(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

test('parseSSEStream reassembles a UTF-8 character split across chunks', async () => {
  const encoder = new TextEncoder();
  const payload = encoder.encode('data: 你好世界\n\n');
  // Slice in the middle of a 3-byte character.
  const chunks = [payload.subarray(0, 8), payload.subarray(8, 11), payload.subarray(11)];

  const messages: string[] = [];
  for await (const message of parseSSEStream(streamFrom(chunks))) {
    messages.push(message.data);
  }
  assert.deepEqual(messages, ['你好世界']);
});

test('parseSSEStream yields every event from a fragmented body', async () => {
  const encoder = new TextEncoder();
  const body = 'data: a\n\ndata: b\n\ndata: c\n\n';
  const bytes = encoder.encode(body);
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < bytes.length; index += 3) {
    chunks.push(bytes.subarray(index, index + 3));
  }

  const messages: string[] = [];
  for await (const message of parseSSEStream(streamFrom(chunks))) {
    messages.push(message.data);
  }
  assert.deepEqual(messages, ['a', 'b', 'c']);
});

test('parseSSEStream cancels the underlying stream when the consumer breaks early', async () => {
  let cancelled = false;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: first\n\n'));
      controller.enqueue(encoder.encode('data: second\n\n'));
    },
    cancel() {
      cancelled = true;
    },
  });

  for await (const message of parseSSEStream(stream)) {
    assert.equal(message.data, 'first');
    break;
  }

  assert.equal(cancelled, true, 'the reader should be released back to the network');
});
