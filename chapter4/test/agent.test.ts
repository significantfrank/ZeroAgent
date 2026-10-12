import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { Agent } from '../src/agent-loop.ts';
import { ResponsesClient } from '../src/client.ts';
import { executeTool, allTools } from '../src/tools.ts';
import type { FunctionCallItem } from '../src/types.ts';

function sse(events: readonly Record<string, unknown>[]): Response {
    const body = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

// ---------------------------------------------------------------------------
// Original weather test (carried over from chapter3)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool registration test
// ---------------------------------------------------------------------------

test('allTools includes the expected tool names', () => {
    const names = allTools.map((t) => t.name);
    assert.deepEqual(names, [
        'get_weather',
        'read_file',
        'write_file',
        'edit_file',
        'run_terminal_command',
        'file_search',
    ]);
});

// ---------------------------------------------------------------------------
// Helper to create a FunctionCallItem
// ---------------------------------------------------------------------------

function makeCall(name: string, args: Record<string, unknown>): FunctionCallItem {
    return { type: 'function_call', call_id: `call_${name}`, name, arguments: JSON.stringify(args) };
}

// ---------------------------------------------------------------------------
// read_file tests
// ---------------------------------------------------------------------------

test('read_file returns file contents with line numbers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-read-'));
    const filePath = join(dir, 'test.txt');
    await writeFile(filePath, 'hello\nworld\n');

    const result = await executeTool(makeCall('read_file', { path: filePath }));
    assert.equal(result.error, undefined);
    assert.equal(result.output, '1|hello\n2|world');

    await rm(dir, { recursive: true });
});

test('read_file supports offset and limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-read-ol-'));
    const filePath = join(dir, 'lines.txt');
    await writeFile(filePath, 'a\nb\nc\nd\ne\n');

    const result = await executeTool(makeCall('read_file', { path: filePath, offset: 2, limit: 2 }));
    assert.equal(result.error, undefined);
    assert.equal(result.output, '2|b\n3|c');

    await rm(dir, { recursive: true });
});

test('read_file errors on missing file', async () => {
    const result = await executeTool(makeCall('read_file', { path: '/nonexistent/path/file.txt' }));
    assert.equal(result.error, 'tool_error');
    assert.ok(result.output.includes('ENOENT') || result.output.includes('no such file'));
});

// ---------------------------------------------------------------------------
// write_file tests
// ---------------------------------------------------------------------------

test('write_file creates a new file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-write-'));
    const filePath = join(dir, 'out.txt');

    const result = await executeTool(makeCall('write_file', { path: filePath, content: 'new content' }));
    assert.equal(result.error, undefined);

    const written = await readFile(filePath, 'utf-8');
    assert.equal(written, 'new content');

    await rm(dir, { recursive: true });
});

test('write_file overwrites an existing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-write-ov-'));
    const filePath = join(dir, 'existing.txt');
    await writeFile(filePath, 'old content');

    await executeTool(makeCall('write_file', { path: filePath, content: 'replaced' }));
    const written = await readFile(filePath, 'utf-8');
    assert.equal(written, 'replaced');

    await rm(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// edit_file tests
// ---------------------------------------------------------------------------

test('edit_file replaces a unique occurrence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-edit-'));
    const filePath = join(dir, 'edit.txt');
    await writeFile(filePath, 'const x = 1;\nconsole.log(x);\n');

    const result = await executeTool(makeCall('edit_file', {
        path: filePath,
        old_text: 'const x = 1;',
        new_text: 'const x = 2;',
    }));
    assert.equal(result.error, undefined);

    const edited = await readFile(filePath, 'utf-8');
    assert.equal(edited, 'const x = 2;\nconsole.log(x);\n');

    await rm(dir, { recursive: true });
});

test('edit_file errors when old_text is not found', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-edit-nf-'));
    const filePath = join(dir, 'edit.txt');
    await writeFile(filePath, 'hello world\n');

    const result = await executeTool(makeCall('edit_file', {
        path: filePath,
        old_text: 'nonexistent',
        new_text: 'replacement',
    }));
    assert.equal(result.error, 'tool_error');
    assert.ok(result.output.includes('not found'));

    await rm(dir, { recursive: true });
});

test('edit_file errors when old_text appears multiple times', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-edit-dup-'));
    const filePath = join(dir, 'edit.txt');
    await writeFile(filePath, 'foo\nfoo\n');

    const result = await executeTool(makeCall('edit_file', {
        path: filePath,
        old_text: 'foo',
        new_text: 'bar',
    }));
    assert.equal(result.error, 'tool_error');
    assert.ok(result.output.includes('2 times'));

    await rm(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// run_terminal_command tests
// ---------------------------------------------------------------------------

test('run_terminal_command executes a shell command', async () => {
    const result = await executeTool(makeCall('run_terminal_command', { command: 'echo hello' }));
    assert.equal(result.error, undefined);
    const parsed = JSON.parse(result.output) as { stdout: string; stderr: string };
    assert.equal(parsed.stdout.trim(), 'hello');
    assert.equal(parsed.stderr, '');
});

test('run_terminal_command captures stderr', async () => {
    const result = await executeTool(makeCall('run_terminal_command', { command: 'echo err >&2' }));
    assert.equal(result.error, undefined);
    const parsed = JSON.parse(result.output) as { stdout: string; stderr: string };
    assert.equal(parsed.stderr.trim(), 'err');
});

// ---------------------------------------------------------------------------
// file_search tests
// ---------------------------------------------------------------------------

test('file_search finds matching lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-search-'));
    await writeFile(join(dir, 'a.ts'), 'const alpha = 1;\nconst beta = 2;\n');
    await writeFile(join(dir, 'b.ts'), 'const alpha = 3;\n');

    const result = await executeTool(makeCall('file_search', { pattern: 'alpha', path: dir }));
    assert.equal(result.error, undefined);
    const parsed = JSON.parse(result.output) as { matches: string; stderr: string };
    assert.ok(parsed.matches.includes('a.ts'));
    assert.ok(parsed.matches.includes('b.ts'));
    assert.ok(parsed.matches.includes('const alpha'));

    await rm(dir, { recursive: true });
});

test('file_search returns empty matches when nothing found', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-search-empty-'));
    await writeFile(join(dir, 'a.ts'), 'hello\n');

    const result = await executeTool(makeCall('file_search', { pattern: 'zzzz_not_found', path: dir }));
    assert.equal(result.error, undefined);
    const parsed = JSON.parse(result.output) as { matches: string; stderr: string };
    assert.equal(parsed.matches, '');

    await rm(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// unknown tool test
// ---------------------------------------------------------------------------

test('executeTool returns error for unknown tool', async () => {
    const result = await executeTool(makeCall('nonexistent_tool', {}));
    assert.equal(result.error, 'unknown_tool');
    assert.ok(result.output.includes('Unknown tool'));
});
