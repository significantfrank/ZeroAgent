import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAIError, ResponsesClient } from '../src/openai/responses.ts';
import type { ResponseStreamEvent } from '../src/openai/types.ts';
import { startMockResponsesServer } from './helpers/mock-server.ts';
import { buildTurn } from './helpers/responses-script.ts';

async function collect(
  client: ResponsesClient,
  request: { model: string; input: string },
  options: { signal?: AbortSignal } = {},
): Promise<ResponseStreamEvent[]> {
  const events: ResponseStreamEvent[] = [];
  for await (const event of client.stream(request, options)) events.push(event);
  return events;
}

test('streams typed events and sends a well-formed request', async () => {
  const server = await startMockResponsesServer(() => ({
    events: buildTurn({ content: ['hi'], usage: { input_tokens: 1, output_tokens: 1 } }),
  }));

  try {
    const client = new ResponsesClient({ apiKey: 'test-key', baseURL: server.url, maxRetries: 0 });
    const events = await collect(client, { model: 'gpt-mock', input: 'hello' });

    assert.ok(events.length > 0);
    assert.equal(events[0]?.type, 'response.created');

    const request = server.requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/responses');
    assert.equal(request.streaming, true);
    assert.equal(request.headers.authorization, 'Bearer test-key');
    assert.equal(request.body?.model, 'gpt-mock');
    assert.equal(request.body?.input, 'hello');
    assert.equal(request.body?.stream, true);
  } finally {
    await server.close();
  }
});

test('parses a body fragmented into single-byte chunks', async () => {
  const server = await startMockResponsesServer(() => ({
    events: buildTurn({ reasoning: ['think'], content: ['你好 world'] }),
    chunkSize: 1,
  }));

  try {
    const client = new ResponsesClient({ apiKey: 'k', baseURL: server.url, maxRetries: 0 });
    const events = await collect(client, { model: 'm', input: 'x' });
    const text = events
      .filter((event) => event.type === 'response.output_text.delta')
      .map((event) => (event.type === 'response.output_text.delta' ? event.delta : ''))
      .join('');
    assert.equal(text, '你好 world');
  } finally {
    await server.close();
  }
});

test('reports unknown event types through onUnknownEvent without breaking the stream', async () => {
  const unknown: unknown[] = [];
  const server = await startMockResponsesServer(() => ({
    raw: [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r1","status":"in_progress","output":[]}}\n\n',
      'event: response.some_future_event\ndata: {"type":"response.some_future_event","brand_new":true}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"m","output_index":0,"content_index":0,"delta":"still works"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}\n\n',
    ].join(''),
  }));

  try {
    const client = new ResponsesClient({
      apiKey: 'k',
      baseURL: server.url,
      maxRetries: 0,
      onUnknownEvent: (payload) => unknown.push(payload),
    });
    const events = await collect(client, { model: 'm', input: 'x' });

    assert.equal(unknown.length, 1);
    assert.deepEqual(unknown[0], { type: 'response.some_future_event', brand_new: true });
    assert.deepEqual(
      events.map((event) => event.type),
      ['response.created', 'response.output_text.delta', 'response.completed'],
    );
  } finally {
    await server.close();
  }
});

test('ignores malformed JSON frames', async () => {
  const server = await startMockResponsesServer(() => ({
    raw: 'data: {not json\n\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n',
  }));

  try {
    const client = new ResponsesClient({ apiKey: 'k', baseURL: server.url, maxRetries: 0 });
    const events = await collect(client, { model: 'm', input: 'x' });
    assert.deepEqual(
      events.map((event) => event.type),
      ['response.completed'],
    );
  } finally {
    await server.close();
  }
});

test('stops at a [DONE] sentinel', async () => {
  const server = await startMockResponsesServer(() => ({
    raw:
      'data: {"type":"response.created","response":{"id":"r","status":"in_progress","output":[]}}\n\n' +
      'data: [DONE]\n\n' +
      'data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n',
  }));

  try {
    const client = new ResponsesClient({ apiKey: 'k', baseURL: server.url, maxRetries: 0 });
    const events = await collect(client, { model: 'm', input: 'x' });
    assert.deepEqual(
      events.map((event) => event.type),
      ['response.created'],
    );
  } finally {
    await server.close();
  }
});

test('flushes a trailing event that was never blank-line terminated', async () => {
  const server = await startMockResponsesServer(() => ({
    raw: 'data: {"type":"response.created","response":{"id":"r","status":"in_progress","output":[]}}',
  }));

  try {
    const client = new ResponsesClient({ apiKey: 'k', baseURL: server.url, maxRetries: 0 });
    const events = await collect(client, { model: 'm', input: 'x' });
    assert.equal(events.length, 1);
  } finally {
    await server.close();
  }
});

test('surfaces an API error with status, code and request id', async () => {
  const server = await startMockResponsesServer(() => ({
    status: 401,
    json: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } },
  }));

  try {
    const client = new ResponsesClient({ apiKey: 'bad', baseURL: server.url, maxRetries: 0 });
    await assert.rejects(
      () => collect(client, { model: 'm', input: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof OpenAIError);
        assert.equal(error.status, 401);
        assert.equal(error.code, 'invalid_api_key');
        assert.equal(error.message, 'Incorrect API key provided');
        assert.equal(error.requestId, 'req_mock_error');
        assert.equal(error.retryable, false);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('retries a 429 and then succeeds', async () => {
  const server = await startMockResponsesServer((_request, index) => {
    if (index === 0) {
      return { status: 429, json: { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } } };
    }
    return { events: buildTurn({ content: ['recovered'] }) };
  });

  try {
    const client = new ResponsesClient({
      apiKey: 'k',
      baseURL: server.url,
      maxRetries: 2,
      retryDelayMs: 1,
    });
    const events = await collect(client, { model: 'm', input: 'x' });

    assert.equal(server.requests.length, 2, 'the request should have been retried once');
    assert.ok(events.some((event) => event.type === 'response.completed'));
  } finally {
    await server.close();
  }
});

test('gives up after maxRetries and reports the last error', async () => {
  const server = await startMockResponsesServer(() => ({
    status: 503,
    json: { error: { message: 'Service unavailable', code: 'server_error' } },
  }));

  try {
    const client = new ResponsesClient({
      apiKey: 'k',
      baseURL: server.url,
      maxRetries: 1,
      retryDelayMs: 1,
    });

    await assert.rejects(
      () => collect(client, { model: 'm', input: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof OpenAIError);
        assert.equal(error.status, 503);
        assert.equal(error.retryable, true);
        return true;
      },
    );
    assert.equal(server.requests.length, 2, 'initial attempt plus one retry');
  } finally {
    await server.close();
  }
});

test('does not retry a non-retryable 400', async () => {
  const server = await startMockResponsesServer(() => ({
    status: 400,
    json: { error: { message: 'Unknown parameter: foo', code: 'unknown_parameter' } },
  }));

  try {
    const client = new ResponsesClient({ apiKey: 'k', baseURL: server.url, maxRetries: 3, retryDelayMs: 1 });
    await assert.rejects(() => collect(client, { model: 'm', input: 'x' }), OpenAIError);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('accepts an error payload that is not nested under "error"', async () => {
  const server = await startMockResponsesServer(() => ({
    status: 502,
    json: { message: 'Bad gateway from an intermediary', code: 'gateway_error' },
  }));

  try {
    const client = new ResponsesClient({ apiKey: 'k', baseURL: server.url, maxRetries: 0 });
    await assert.rejects(
      () => collect(client, { model: 'm', input: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof OpenAIError);
        assert.equal(error.status, 502);
        assert.equal(error.message, 'Bad gateway from an intermediary');
        assert.equal(error.code, 'gateway_error');
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('maps a connection dropped mid-stream to a non-retryable stream error', async () => {
  const server = await startMockResponsesServer((_request, index) => {
    if (index === 0) {
      return {
        raw: 'data: {"type":"response.created","response":{"id":"r","status":"in_progress","output":[]}}\n\n',
        destroy: true,
      };
    }
    return { events: buildTurn({ content: ['never reached'] }) };
  });

  try {
    const client = new ResponsesClient({ apiKey: 'k', baseURL: server.url, maxRetries: 2, retryDelayMs: 1 });
    await assert.rejects(
      () => collect(client, { model: 'm', input: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof OpenAIError);
        // Partial consumption means retrying would duplicate events.
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(server.requests.length, 1, 'a partially consumed stream must not be retried');
  } finally {
    await server.close();
  }
});

test('honours an abort signal', async () => {
  const server = await startMockResponsesServer(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { events: buildTurn({ content: ['too slow'] }) };
  });

  try {
    const client = new ResponsesClient({ apiKey: 'k', baseURL: server.url, maxRetries: 0 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await assert.rejects(
      () => collect(client, { model: 'm', input: 'x' }, { signal: controller.signal }),
      (error: unknown) => {
        assert.ok(error instanceof OpenAIError);
        assert.equal(error.code, 'aborted');
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('refuses to call api.openai.com without an API key', async () => {
  const client = new ResponsesClient({ apiKey: '', maxRetries: 0 });
  await assert.rejects(
    () => collect(client, { model: 'm', input: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof OpenAIError);
      assert.equal(error.code, 'missing_api_key');
      return true;
    },
  );
});

test('reads the base URL and API key from the environment', async () => {
  const server = await startMockResponsesServer(() => ({ events: buildTurn({ content: ['env'] }) }));
  const previousKey = process.env.OPENAI_API_KEY;
  const previousUrl = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_API_KEY = 'env-key';
  process.env.OPENAI_BASE_URL = server.url;

  try {
    const client = new ResponsesClient({ maxRetries: 0 });
    const events = await collect(client, { model: 'm', input: 'x' });

    assert.ok(events.length > 0, 'should have reached the server configured by OPENAI_BASE_URL');
    assert.equal(server.requests[0]?.headers.authorization, 'Bearer env-key');
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousUrl;
    await server.close();
  }
});

test('create() performs a non-streaming request', async () => {
  const server = await startMockResponsesServer(() => ({
    raw: JSON.stringify({ id: 'resp_1', status: 'completed', output: [], output_text: 'done' }),
  }));

  try {
    const client = new ResponsesClient({ apiKey: 'k', baseURL: server.url, maxRetries: 0 });
    const response = await client.create({ model: 'm', input: 'x' });

    assert.equal(response.id, 'resp_1');
    assert.equal(response.status, 'completed');
    assert.equal(server.requests[0]?.body?.stream, false);
  } finally {
    await server.close();
  }
});
