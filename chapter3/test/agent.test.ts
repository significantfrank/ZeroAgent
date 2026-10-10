import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent-loop.ts';
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
            assert.equal(body.input.length, 5);
            assert.deepEqual(body.input[1], {
                type: 'function_call',
                call_id: 'call_weather',
                name: 'get_weather',
                arguments: '{"city":"Tokyo"}',
            });
            assert.deepEqual(body.input[2], {
                type: 'function_call',
                call_id: 'call_weather_hangzhou',
                name: 'get_weather',
                arguments: '{"city":"杭州"}',
            });
            assert.deepEqual(body.input[3], {
                type: 'function_call_output',
                call_id: 'call_weather',
                output: '{"city":"Tokyo","temperature_c":18,"condition":"cloudy"}',
            });
            assert.deepEqual(body.input[4], {
                type: 'function_call_output',
                call_id: 'call_weather_hangzhou',
                output: '{"city":"杭州","temperature_c":20,"condition":"clear"}',
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
                    },
                },
                {
                    type: 'response.output_item.done', item: {
                        type: 'function_call',
                        call_id: 'call_weather_hangzhou',
                        name: 'get_weather',
                        arguments: '{"city":"杭州"}',
                    },
                },
                {
                    type: 'response.completed', response: {
                        usage: {
                            input_tokens: 168,
                            output_tokens: 22,
                            total_tokens: 190,
                            input_tokens_details: { cached_tokens: 0 },
                            output_tokens_details: { reasoning_tokens: 0 },
                        },
                    },
                },
            ]);
        }

        return sse([
            {
                type: 'response.output_item.done', item: {
                    type: 'message',
                    phase: 'final_answer',
                    content: [{
                        type: 'output_text',
                        text: 'Tokyo is cloudy; Hangzhou is clear.',
                    }],
                },
            },
            {
                type: 'response.completed', response: {
                    usage: {
                        input_tokens: 224,
                        output_tokens: 59,
                        total_tokens: 283,
                        input_tokens_details: { cached_tokens: 0 },
                        output_tokens_details: { reasoning_tokens: 0 },
                    },
                },
            },
        ]);
    };

    const agent = new Agent(new ResponsesClient({ apiKey: 'test-key', fetch: fetchMock }));
    const events = [];
    for await (const event of agent.stream('What is the weather in Tokyo?')) events.push(event);

    assert.equal(requestCount, 2);
    assert.deepEqual(
        events.filter((event) => event.type === 'tool_call' || event.type === 'tool_result').map((event) => event.type),
        ['tool_call', 'tool_result', 'tool_call', 'tool_result'],
    );
    assert.deepEqual(
        events.filter((event) => event.type === 'token_usage'),
        [
            { type: 'token_usage', step: 1, inputTokens: 168, outputTokens: 22, totalTokens: 190 },
            { type: 'token_usage', step: 2, inputTokens: 224, outputTokens: 59, totalTokens: 283 },
        ],
    );
    assert.deepEqual(events.at(-1), { type: 'run_end', steps: 2, text: 'Tokyo is cloudy; Hangzhou is clear.' });
});