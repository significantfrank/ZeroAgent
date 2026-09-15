import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent.ts';
import { ResponsesClient } from '../src/client.ts';

function sse(events: readonly Record<string, unknown>[]): Response {
    const body = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

test('runs a tool call and continues to a final answer', async () => {
    let requestCount = 0;
    const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requestCount += 1;
        assert.equal(init?.method, 'POST');
        const body = JSON.parse(String(init?.body)) as { input: unknown[] };

        if (requestCount === 2) {
            assert.equal(body.input.length, 3);
            assert.deepEqual(body.input[1], {
                type: 'function_call',
                call_id: 'call_weather',
                name: 'get_weather',
                arguments: '{"city":"Tokyo"}',
            });
            assert.deepEqual(body.input[2], {
                type: 'function_call_output',
                call_id: 'call_weather',
                output: '{"city":"Tokyo","temperature_c":18,"condition":"cloudy"}',
            });
        }

        if (requestCount === 1) {
            return sse([
                {
                    type: 'response.output_item.done', item: {
                        type: 'function_call',
                        call_id: 'call_weather',
                        name: 'get_weather',
                        arguments: '{"city":"Tokyo"}',
                    }
                },
                { type: 'response.completed', response: { output: [] } },
            ]);
        }

        return sse([
            { type: 'response.output_text.delta', delta: 'Tokyo is cloudy.' },
            { type: 'response.completed', response: { output: [] } },
        ]);
    };

    const agent = new Agent(new ResponsesClient({ apiKey: 'test-key', fetch: fetchMock }));
    const events = [];
    for await (const event of agent.stream('What is the weather in Tokyo?')) events.push(event);

    assert.equal(requestCount, 2);
    assert.equal(events.filter((event) => event.type === 'tool_call').length, 1);
    assert.equal(events.filter((event) => event.type === 'tool_result').length, 1);
    assert.deepEqual(events.at(-1), { type: 'run_end', steps: 2, text: 'Tokyo is cloudy.' });
});