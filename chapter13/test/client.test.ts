import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiClient, OpenAiClient } from '../src/ai/index.ts';

function sse(events: readonly Record<string, unknown>[]): Response {
    const body = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const completed = {
    type: 'response.completed',
    response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
};

type Call = { url: string; auth: string };

test('AI client factory routes OpenAI-compatible providers to OpenAiClient', () => {
    const options = {
        resolveProvider: () => ({ baseUrl: 'https://test.invalid/v1', key: 'test-key' }),
    };

    assert.ok(createAiClient('openai', options) instanceof OpenAiClient);
    assert.ok(createAiClient('glm', options) instanceof OpenAiClient);
    assert.ok(createAiClient('deepseek', options) instanceof OpenAiClient);
    assert.throws(() => createAiClient('unknown', options), /Unsupported AI provider "unknown"/);
});

test('routes to provider baseUrl and key when the resolver matches', async () => {
    const calls: Call[] = [];
    const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(input), auth: headers.get('authorization') ?? '' });
        return sse([completed]);
    };
    const client = new OpenAiClient({
        fetch: fetchMock,
        resolveProvider: (model) => model === 'deepseek-flash'
            ? { baseUrl: 'https://api.deepseek.com/v1', key: 'sk-deepseek' }
            : undefined,
    });
    const events = [];
    for await (const event of client.stream({ model: 'deepseek-flash', input: 'hi' })) events.push(event);

    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.url.startsWith('https://api.deepseek.com/v1/responses'));
    assert.ok(calls[0]!.auth.startsWith('Bearer '));
    assert.deepEqual(events, [{ type: 'start' }, { type: 'done', reason: 'completed' }]);
});

test('normalizes Responses text deltas into assistant message events', async () => {
    const client = new OpenAiClient({
        fetch: async () => sse([
            { type: 'response.output_text.delta', delta: 'Hello' },
            { type: 'response.output_text.delta', delta: ' world' },
            { type: 'response.output_text.done', text: 'Hello world' },
            { type: 'response.completed', response: { status: 'completed' } },
        ]),
        resolveProvider: () => ({ baseUrl: 'https://test.invalid/v1', key: 'test-key' }),
    });
    const events = [];
    for await (const event of client.stream({ model: 'test-model', input: 'hi' })) events.push(event);

    assert.deepEqual(events, [
        { type: 'start' },
        { type: 'text_start' },
        { type: 'text_delta', delta: 'Hello' },
        { type: 'text_delta', delta: ' world' },
        { type: 'text_end', content: 'Hello world' },
        { type: 'done', reason: 'completed' },
    ]);
});

test('passes the request signal through to fetch', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const client = new OpenAiClient({
        fetch: async (_input, init) => {
            receivedSignal = init?.signal;
            return sse([completed]);
        },
        resolveProvider: () => ({ baseUrl: 'https://test.invalid/v1', key: 'test-key' }),
    });

    for await (const _event of client.stream({ model: 'test-model', input: 'hi', signal: controller.signal })) {
        // Consume the provider stream.
    }

    assert.ok(receivedSignal instanceof AbortSignal);
    controller.abort();
    assert.equal(receivedSignal.aborted, true);
});
