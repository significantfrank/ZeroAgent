import assert from 'node:assert/strict';
import test from 'node:test';
import { ResponsesClient } from '../src/client.ts';

function sse(events: readonly Record<string, unknown>[]): Response {
    const body = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const completed = {
    type: 'response.completed',
    response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
};

type Call = { url: string; auth: string };

test('routes to provider baseUrl and key when the resolver matches', async () => {
    const calls: Call[] = [];
    const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(input), auth: headers.get('authorization') ?? '' });
        return sse([completed]);
    };
    const client = new ResponsesClient({
        fetch: fetchMock,
        resolveProvider: (model) => model === 'deepseek-flash'
            ? { baseUrl: 'https://api.deepseek.com/v1', key: 'sk-deepseek' }
            : undefined,
    });
    for await (const _ of client.stream({ model: 'deepseek-flash', input: 'hi' })) { /* drain */ }

    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.url.startsWith('https://api.deepseek.com/v1/responses'));
    assert.equal(calls[0]!.auth, 'Bearer sk-deepseek');
});

