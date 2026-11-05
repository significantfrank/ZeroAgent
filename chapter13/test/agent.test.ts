import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { Agent } from '../src/agent/agent-loop.ts';
import type { AgentEvent } from '../src/agent/types.ts';
import { PromptRequestBuilder } from '../src/request-builder.ts';
import { loadSkills } from '../src/skill/index.ts';
import { createTestAgent, createTestClient } from './helpers.ts';
import {
    allTools,
    executeTool as dispatchTool,
    registerBuiltInToolHandlers,
    runSubagentTool,
    ToolRegistry,
} from '../src/tool/index.ts';
import type { FunctionCallItem } from '../src/tool/types.ts';

function sse(events: readonly Record<string, unknown>[]): Response {
    const body = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const localTestAgent = createTestAgent(createTestClient());
registerBuiltInToolHandlers(localTestAgent);
const localTestRegistry = localTestAgent.tools;

function executeTool(call: FunctionCallItem, handlers: ToolRegistry = localTestRegistry) {
    return dispatchTool(call, handlers);
}

function registerAgentToolHandlers(agent: Agent): void {
    registerBuiltInToolHandlers(agent);
}

function registerTestWeatherTool(agent: Agent): void {
    agent.tools.register({
        type: 'function',
        name: 'get_weather',
        description: 'Return test weather data.',
        parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
            additionalProperties: false,
        },
        strict: true,
    }, (_call, args) => {
        const city = args.city;
        if (typeof city !== 'string') throw new Error('city is required');
        return JSON.stringify({
            city,
            temperature_c: city === 'Tokyo' ? 18 : 20,
            condition: city === 'Tokyo' ? 'cloudy' : 'clear',
        });
    });
}

// ---------------------------------------------------------------------------
// Original weather test (carried over from chapter3)
// ---------------------------------------------------------------------------

test('runs a tool call and continues to a final answer', async () => {
    // Isolate from real ~/.zeroagent/skills/ by pointing HOME to a temp dir
    const realHome = process.env.HOME;
    const tempHome = await mkdtemp(join(tmpdir(), 'za-home-'));
    process.env.HOME = tempHome;
    try {
        let requestCount = 0;
        const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            requestCount += 1;
            assert.equal(init?.method, 'POST');
            const body = JSON.parse(String(init?.body)) as { input: unknown[] };

            if (requestCount === 2) {
                assert.equal(body.input.length, 6);
                assert.deepEqual(body.input[0], {
                    role: 'developer',
                    content: `Working directory: ${process.cwd()}. Resolve relative paths from this directory.`,
                });
                assert.deepEqual(body.input[2], {
                    type: 'function_call',
                    call_id: 'call_weather',
                    name: 'get_weather',
                    arguments: '{"city":"Tokyo"}',
                });
                assert.deepEqual(body.input[3], {
                    type: 'function_call',
                    call_id: 'call_weather_hangzhou',
                    name: 'get_weather',
                    arguments: '{"city":"杭州"}',
                });
                assert.deepEqual(body.input[4], {
                    type: 'function_call_output',
                    call_id: 'call_weather',
                    output: '{"city":"Tokyo","temperature_c":18,"condition":"cloudy"}',
                });
                assert.deepEqual(body.input[5], {
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

        const agent = createTestAgent(createTestClient(fetchMock), { model: 'test-model' });
        registerAgentToolHandlers(agent);
        registerTestWeatherTool(agent);
        const events = [];
        let lastAssistant = '';
        for await (const event of agent.stream('What is the weather in Tokyo?')) {
            events.push(event);
            if (event.type === 'turn_end' && event.message.role === 'assistant') {
                lastAssistant = event.message.content;
            }
        }

        assert.equal(requestCount, 2);
        assert.deepEqual(
            events.filter((event) => event.type === 'tool_execution_start' || event.type === 'tool_execution_end').map((event) => event.type),
            ['tool_execution_start', 'tool_execution_end', 'tool_execution_start', 'tool_execution_end'],
        );
        assert.ok(events
            .filter((event) => event.type === 'message_start')
            .every((event) => Object.keys(event).length === 1));
        const messageEnds = events.filter((event) => event.type === 'message_end');
        assert.deepEqual(messageEnds, [
            {
                type: 'message_end',
                message: {
                    role: 'assistant',
                    content: '',
                    toolCalls: [
                        { id: 'call_weather', name: 'get_weather', arguments: '{"city":"Tokyo"}' },
                        { id: 'call_weather_hangzhou', name: 'get_weather', arguments: '{"city":"杭州"}' },
                    ],
                },
            },
            { type: 'message_end', message: { role: 'assistant', content: 'Tokyo is cloudy; Hangzhou is clear.' } },
        ]);
        assert.ok(events.indexOf(messageEnds[0]!) < events.findIndex((event) => event.type === 'tool_execution_start'));
        const finalEvent = events.at(-1);
        assert.equal(finalEvent?.type, 'agent_end');
        assert.equal(lastAssistant, 'Tokyo is cloudy; Hangzhou is clear.');
    } finally {
        process.env.HOME = realHome;
        await rm(tempHome, { recursive: true });
    }
});

test('Agent consumes provider-neutral client events and includes signal in AiRequest', async () => {
    const controller = new AbortController();
    const agent = createTestAgent({
        async *stream(request) {
            assert.equal(request.signal, controller.signal);
            yield { type: 'start' };
            yield { type: 'text_start' };
            yield { type: 'text_delta', delta: 'Hello' };
            yield { type: 'text_end', content: 'Hello' };
            yield { type: 'done', reason: 'complete' };
        },
    }, { model: 'generic-model' });

    const events = [];
    let lastAssistant = '';
    for await (const event of agent.stream('Hi', { signal: controller.signal })) {
        events.push(event);
        if (event.type === 'turn_end' && event.message.role === 'assistant') {
            lastAssistant = event.message.content;
        }
    }

    assert.equal(events[0]?.type, 'agent_start');
    const turnStart = events.findIndex((event) => event.type === 'turn_start');
    const messageStart = events.findIndex((event) => event.type === 'message_start');
    assert.ok(turnStart > 0);
    assert.ok(messageStart > turnStart);
    assert.ok(events
        .filter((event) => event.type === 'message_start')
        .every((event) => Object.keys(event).length === 1));
    assert.deepEqual(events.filter((event) => event.type === 'message_end'), [
        { type: 'message_end', message: { role: 'assistant', content: 'Hello' } },
    ]);
    assert.ok(events.some((event) => event.type === 'message_update' &&
        event.aiEvent.type === 'text_delta'));
    assert.ok(!events.some((event) => event.type === 'message_update' &&
        (event.aiEvent.type === 'start' || event.aiEvent.type === 'done')));
    const end = events.at(-1);
    assert.equal(end?.type, 'agent_end');
    assert.equal(lastAssistant, 'Hello');
});

test('message ends once on done with all assistant response content', async () => {
    const agent = createTestAgent({
        async *stream() {
            yield { type: 'start' };
            yield { type: 'text_end', content: 'Answer' };
            yield { type: 'thinking_end', content: 'Reasoning' };
            yield { type: 'done', reason: 'complete' };
        },
    }, { model: 'generic-model' });

    const events: AgentEvent[] = [];
    for await (const event of agent.stream('Hi')) events.push(event);

    const messageEnd = events.findIndex((event) => event.type === 'message_end');
    const turnEnd = events.findIndex((event) => event.type === 'turn_end');
    assert.ok(messageEnd >= 0 && turnEnd > messageEnd);
    assert.deepEqual(events.filter((event) => event.type === 'message_end'), [
        { type: 'message_end', message: { role: 'assistant', content: 'Answer', thinking: 'Reasoning' } },
    ]);
});

test('thinking-only response emits message_end on done', async () => {
    const agent = createTestAgent({
        async *stream() {
            yield { type: 'start' };
            yield { type: 'thinking_end', content: 'Reasoning' };
            yield { type: 'done', reason: 'complete' };
        },
    }, { model: 'generic-model' });

    const events: AgentEvent[] = [];
    for await (const event of agent.stream('Hi')) events.push(event);

    assert.deepEqual(events.filter((event) => event.type === 'message_end'), [
        { type: 'message_end', message: { role: 'assistant', content: '', thinking: 'Reasoning' } },
    ]);
});

test('request builder adds developer messages and runtime tools', () => {
    const builder = new PromptRequestBuilder('test-model')
        .addDeveloperMsg('Working directory: /tmp/project')
        .addUserMsg('Inspect the project');
    const tool = allTools[0]!;

    assert.deepEqual(builder.build().tools, []);
    builder.addTool(tool);
    const request = builder.build();

    assert.deepEqual(request.input, [
        { role: 'developer', content: 'Working directory: /tmp/project' },
        { role: 'user', content: 'Inspect the project' },
    ]);
    assert.deepEqual(request.tools, [tool]);
    assert.equal(request.model, 'test-model');
});

test('parent delegates to a child agent that can use built-in tools', async () => {
    const realHome = process.env.HOME;
    const tempHome = await mkdtemp(join(tmpdir(), 'za-subagent-home-'));
    const workdir = await mkdtemp(join(tmpdir(), 'za-subagent-workdir-'));
    process.env.HOME = tempHome;
    try {
        const notePath = join(workdir, 'weather.txt');
        await writeFile(notePath, 'Tokyo is 18°C and cloudy.');
        const requests: Array<{
            model: string;
            input: unknown[];
            tools: Array<{ name: string }>;
        }> = [];
        const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            requests.push(JSON.parse(String(init?.body)) as typeof requests[number]);
            switch (requests.length) {
                case 1:
                    return sse([{
                        type: 'response.output_item.done',
                        item: {
                            type: 'function_call',
                            call_id: 'call_run_subagent',
                            name: 'run_subagent',
                            arguments: JSON.stringify({ task: 'Find the weather in Tokyo.' }),
                        },
                    }]);
                case 2:
                    return sse([{
                        type: 'response.output_item.done',
                        item: {
                            type: 'function_call',
                            call_id: 'call_child_read_file',
                            name: 'read_file',
                            arguments: JSON.stringify({ path: notePath }),
                        },
                    }]);
                case 3:
                    return sse([{
                        type: 'response.output_item.done',
                        item: {
                            type: 'message',
                            phase: 'final_answer',
                            content: [{ type: 'output_text', text: 'Tokyo is 18°C and cloudy.' }],
                        },
                    }]);
                default:
                    return sse([{
                        type: 'response.output_item.done',
                        item: {
                            type: 'message',
                            phase: 'final_answer',
                            content: [{ type: 'output_text', text: 'The child found that Tokyo is 18°C and cloudy.' }],
                        },
                    }]);
            }
        };

        const agent = createTestAgent(
            createTestClient(fetchMock),
            { model: 'test-model', workdir },
        );
        registerAgentToolHandlers(agent);
        const events = [];
        const rendered: string[] = [];
        const originalLog = console.log;
        console.log = (...args: unknown[]) => rendered.push(args.join(' '));
        try {
            for await (const event of agent.stream('Research Tokyo weather')) events.push(event);
        } finally {
            console.log = originalLog;
        }

        assert.equal(requests.length, 4);
        assert.ok(rendered.some((line) => line.includes('[general subagent]')));
        assert.ok(rendered.some((line) => line.includes('[tool_call] read_file')));
        assert.equal(requests[0]?.model, 'test-model');
        assert.ok(requests[0]?.tools.some((tool) => tool.name === 'run_subagent'));

        const childFirstRequest = requests[1]!;
        assert.equal(childFirstRequest.model, 'test-model');
        assert.ok(childFirstRequest.tools.some((tool) => tool.name === 'read_file'));
        assert.ok(childFirstRequest.tools.some((tool) => tool.name === 'run_subagent'));
        assert.ok(JSON.stringify(childFirstRequest.input).includes(`Working directory: ${workdir}`));
        assert.ok(JSON.stringify(childFirstRequest.input).includes('Find the weather in Tokyo.'));
        assert.ok(!JSON.stringify(childFirstRequest.input).includes('Research Tokyo weather'));

        const childFollowUpInput = requests[2]?.input;
        assert.ok(JSON.stringify(childFollowUpInput).includes('"name":"read_file"'));
        assert.ok(JSON.stringify(childFollowUpInput).includes('"output":"1|Tokyo is 18°C and cloudy."'));

        const parentFollowUpInput = requests[3]?.input;
        assert.ok(JSON.stringify(parentFollowUpInput).includes('"name":"run_subagent"'));
        assert.ok(JSON.stringify(parentFollowUpInput).includes('Tokyo is 18°C and cloudy.'));
        const finalEvent = events.at(-1);
        assert.equal(finalEvent?.type, 'agent_end');
        const parentTurnEnd = [...events]
            .reverse()
            .find((event): event is Extract<AgentEvent, { type: 'turn_end' }> =>
                event.type === 'turn_end' && event.message.role === 'assistant');
        assert.equal(parentTurnEnd?.message.content,
            'The child found that Tokyo is 18°C and cloudy.');
    } finally {
        process.env.HOME = realHome;
        await rm(tempHome, { recursive: true });
        await rm(workdir, { recursive: true });
    }
});

// ---------------------------------------------------------------------------
// Tool registration test
// ---------------------------------------------------------------------------

test('allTools includes the expected tool names', () => {
    const names = allTools.map((t) => t.name);
    assert.deepEqual(names, [
        'read_file',
        'write_file',
        'edit_file',
        'run_terminal_command',
        'file_search',
        'load_skill',
        'run_subagent',
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

test('executeTool dispatches registered custom tool handlers', async () => {
    const handlers = new ToolRegistry();
    handlers.register(runSubagentTool, (_call, args) => `Delegated: ${String(args.task)}`);

    const result = await executeTool(makeCall('run_subagent', { task: 'Inspect the project.' }), handlers);
    assert.equal(result.error, undefined);
    assert.equal(result.output, 'Delegated: Inspect the project.');
});
