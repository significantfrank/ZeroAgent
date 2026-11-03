import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ExtensionRunner, loadExtensions } from '../src/extension/index.ts';
import { composeSystemPrompt, createSystemPromptOptions } from '../src/agent/system-prompt.ts';
import { Agent } from '../src/agent/agent-loop.ts';
import { AgentBridge } from '../src/agent/agent-bridge.ts';
import { SessionManager } from '../src/session/manager.ts';
import { SessionStore } from '../src/session/store.ts';
import { createTestAgent, createTestClient } from './helpers.ts';

function sse(events: readonly Record<string, unknown>[]): Response {
    const body = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function mkdtempSync(prefix: string): string {
    const dir = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function finalAnswer(text: string): Record<string, unknown>[] {
    return [
        {
            type: 'response.output_item.done',
            item: { type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text }] },
        },
        {
            type: 'response.completed',
            response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        },
    ];
}

test('ExtensionRunner dispatches before_agent_start and aggregates messages', async () => {
    const runner = new ExtensionRunner();

    runner.on('before_agent_start', (event) => {
        assert.equal(event.type, 'before_agent_start');
        assert.equal(event.input, 'hello');
        event.systemPromptOptions.sections['project_context'] = 'Project rules.';
        event.systemPromptOptions.appendSystemPrompt += 'Answer in Chinese.';
        return { messages: [{ role: 'system', content: 'injected-a' }] };
    });
    runner.on('before_agent_start', () => ({
        messages: [{ role: 'user', content: 'injected-b' }],
    }));

    const options = createSystemPromptOptions('base');
    const result = await runner.emitBeforeAgentStart('hello', options);

    assert.equal(composeSystemPrompt(options), 'base\n\nProject rules.\n\nAnswer in Chinese.');
    assert.deepEqual(result.messages, [
        { role: 'system', content: 'injected-a' },
        { role: 'user', content: 'injected-b' },
    ]);
});

test('before_agent_start can mutate systemPromptOptions and inject messages into the request', async () => {
    let captured: { instructions?: string; input?: Array<{ role?: string; content?: string }> } = {};
    const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        captured = JSON.parse(String(init?.body)) as typeof captured;
        return sse(finalAnswer('ok'));
    };

    const runner = new ExtensionRunner();
    runner.on('before_agent_start', (event) => {
        assert.equal(event.systemPrompt, '');
        event.systemPromptOptions.sections['project_context'] = 'Project rules.';
        event.systemPromptOptions.appendSystemPrompt += 'Answer concisely.';
        return { messages: [{ role: 'system', content: 'Injected message' }] };
    });

    const agent = createTestAgent(createTestClient(fetchMock), { model: 'test-model', extensions: runner });
    for await (const _event of agent.stream('hello')) {
        // Drain the stream; the request is captured inside fetchMock.
    }

    assert.equal(captured.instructions, 'Project rules.\n\nAnswer concisely.');
    const input = captured.input ?? [];
    assert.equal(input.length, 3);
    assert.equal(input[0]?.role, 'developer');
    assert.deepEqual(input[1], { role: 'system', content: 'Injected message' });
    assert.deepEqual(input[2], { role: 'user', content: 'hello' });
});

test('example extension registers its hook, greeting command, and executable tool', async () => {
    const runner = new ExtensionRunner();
    const path = fileURLToPath(new URL('../.zeroagent/extensions/test-ext.ts', import.meta.url));
    const extension = await runner.loadExtensionFile('test-ext', path);
    assert.ok(extension.commands?.has('hello'));
    assert.ok(extension.tools?.has('get_answer'));

    const command = runner.getCommand('hello');
    assert.ok(command);
    assert.equal(command.description, 'Show a greeting');
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));
    try {
        await command.handler('', { input: '/hello' });
        await command.handler('Alice', { input: '/hello Alice' });

        const requests: Array<{ instructions?: string; input?: unknown[]; tools?: unknown[] }> = [];
        const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            requests.push(JSON.parse(String(init?.body)) as (typeof requests)[number]);
            if (requests.length === 1) {
                return sse([
                    {
                        type: 'response.output_item.done',
                        item: { type: 'function_call', call_id: 'answer-1', name: 'get_answer', arguments: '{}' },
                    },
                    { type: 'response.completed', response: { status: 'completed' } },
                ]);
            }
            return sse(finalAnswer('The answer is 42.'));
        };
        const agent = createTestAgent(createTestClient(fetchMock), { model: 'test-model', extensions: runner });
        const events = [];
        for await (const event of agent.stream('What is the answer?')) events.push(event);

        assert.deepEqual(output, ['Hello, world!', 'Hello, Alice!', 'before_agent_start extension']);
        assert.equal(requests.length, 2);
        assert.ok(requests[0]?.instructions?.includes('Project context from test extension.'));
        assert.deepEqual(requests[0]?.tools?.find((tool) =>
            typeof tool === 'object' && tool !== null && 'name' in tool && tool.name === 'get_answer'), {
            type: 'function',
            name: 'get_answer',
            description: 'Return the answer.',
            parameters: { type: 'object', properties: {} },
            strict: true,
        });
        assert.ok(requests[1]?.input?.some((item) =>
            typeof item === 'object' && item !== null &&
            'type' in item && item.type === 'function_call_output' &&
            'call_id' in item && item.call_id === 'answer-1' &&
            'output' in item && item.output === '42'));
        assert.ok(events.some((event) => event.type === 'tool_execution_end' &&
            event.toolName === 'get_answer' && event.result === '42' && !event.isError));
        assert.ok(!events.some((event) => event.type === 'error'));
    } finally {
        console.log = originalLog;
        runner.unloadAll();
    }

    assert.equal(runner.getCommand('hello'), undefined);
    assert.equal(runner.registeredTools().length, 0);
});

test('AgentBridge exposes AgentEvents to extensions', async () => {
    const dir = mkdtempSync('za-ext-');
    try {
        const manager = new SessionManager(new SessionStore(join(dir, 'sessions.db')));
        const session = manager.createSession('/workspace');

        const runner = new ExtensionRunner();
        const seen: string[] = [];
        runner.on('tool_execution_end', () => {
            seen.push('tool_end');
        });
        runner.on('agent_end', (event) => {
            assert.equal(event.message.role, 'assistant');
            seen.push(event.message.content);
        });

        const bridge = new AgentBridge(manager, session.id, 'hi', runner);
        await bridge.handleAgentEvent({ type: 'agent_start' });
        await bridge.handleAgentEvent({
            type: 'tool_execution_end',
            toolCallId: 'c1',
            toolName: 'lookup',
            result: 'x',
            isError: false,
        });
        await bridge.handleAgentEvent({ type: 'agent_end', message: { role: 'assistant', content: 'bye' } });

        assert.deepEqual(seen, ['tool_end', 'bye']);
        manager.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('loadExtensions loads a .ts extension and its before_agent_start hook', async () => {
    const dir = mkdtempSync('za-extload-');
    try {
        const workdir = join(dir, 'project');
        const extDir = join(workdir, '.zeroagent', 'extensions');
        mkdirSync(extDir, { recursive: true });
        writeFileSync(join(extDir, 'react-hint.ts'), [
            'export default function (zeroagent) {',
            "    zeroagent.on('before_agent_start', (event) => {",
            "        event.systemPromptOptions.sections['hint'] = 'You are a ReAct agent.';",
            '    });',
            '}',
        ].join('\n'));

        const runner = new ExtensionRunner();
        const loaded = await loadExtensions(workdir, runner);
        assert.equal(loaded.length, 1);
        assert.equal(loaded[0]?.path, 'react-hint');

        const options = createSystemPromptOptions('base');
        await runner.emitBeforeAgentStart('hi', options);
        assert.equal(composeSystemPrompt(options), 'base\n\nYou are a ReAct agent.');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('project extension overrides a user extension with the same name', async () => {
    const dir = mkdtempSync('za-extover-');
    const realHome = process.env.HOME;
    try {
        const home = join(dir, 'home');
        process.env.HOME = home;
        const userExtDir = join(home, '.zeroagent', 'extensions');
        mkdirSync(userExtDir, { recursive: true });
        writeFileSync(join(userExtDir, 'hint.ts'), [
            'export default function (zeroagent) {',
            "    zeroagent.on('before_agent_start', (event) => {",
            "        event.systemPromptOptions.sections['hint'] = 'user hint';",
            '    });',
            '}',
        ].join('\n'));

        const workdir = join(dir, 'project');
        const projectExtDir = join(workdir, '.zeroagent', 'extensions');
        mkdirSync(projectExtDir, { recursive: true });
        writeFileSync(join(projectExtDir, 'hint.ts'), [
            'export default function (zeroagent) {',
            "    zeroagent.on('before_agent_start', (event) => {",
            "        event.systemPromptOptions.sections['hint'] = 'project hint';",
            '    });',
            '}',
        ].join('\n'));

        const runner = new ExtensionRunner();
        const loaded = await loadExtensions(workdir, runner);
        assert.equal(loaded.length, 1);
        assert.equal(loaded[0]?.path, 'hint');

        const options = createSystemPromptOptions('base');
        await runner.emitBeforeAgentStart('hi', options);
        assert.equal(composeSystemPrompt(options), 'base\n\nproject hint');
    } finally {
        if (realHome === undefined) delete process.env.HOME;
        else process.env.HOME = realHome;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('an extension can register a command', async () => {
    const dir = mkdtempSync('za-extcmd-');
    const realHome = process.env.HOME;
    try {
        const home = join(dir, 'home');
        process.env.HOME = home;
        mkdirSync(home, { recursive: true });

        const workdir = join(dir, 'project');
        const extDir = join(workdir, '.zeroagent', 'extensions');
        mkdirSync(extDir, { recursive: true });
        writeFileSync(join(extDir, 'hello.ts'), [
            'export default function (zeroagent) {',
            "    zeroagent.registerCommand('hello', {",
            "        description: 'Show a greeting',",
            '        async handler(args) {',
            "            console.log(`Hello, ${args || 'world'}!`);",
            '        },',
            '    });',
            '}',
        ].join('\n'));

        const runner = new ExtensionRunner();
        const loaded = await loadExtensions(workdir, runner);
        assert.equal(loaded.length, 1);

        const command = runner.getCommand('hello');
        assert.ok(command !== undefined);
        assert.equal(command.description, 'Show a greeting');

        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args: unknown[]) => {
            logs.push(args.map(String).join(' '));
        };
        try {
            await command.handler('world', { input: '/hello world' });
        } finally {
            console.log = originalLog;
        }
        assert.ok(logs.includes('Hello, world!'));
    } finally {
        if (realHome === undefined) delete process.env.HOME;
        else process.env.HOME = realHome;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('an extension can register a tool that the agent declares and executes', async () => {
    const dir = mkdtempSync('za-exttool-');
    const realHome = process.env.HOME;
    try {
        const home = join(dir, 'home');
        process.env.HOME = home;
        mkdirSync(home, { recursive: true });

        const workdir = join(dir, 'project');
        const extDir = join(workdir, '.zeroagent', 'extensions');
        mkdirSync(extDir, { recursive: true });
        writeFileSync(join(extDir, 'answer.ts'), [
            'export default function (zeroagent) {',
            '    zeroagent.registerTool(',
            "        { type: 'function', name: 'get_answer', description: 'Returns the answer.', parameters: { type: 'object', properties: {} }, strict: true },",
            "        async () => '42',",
            '    );',
            '}',
        ].join('\n'));

        const runner = new ExtensionRunner();
        await loadExtensions(workdir, runner);

        let requestCount = 0;
        const requests: Array<{ input?: unknown[]; tools?: Array<{ name?: string }> }> = [];
        const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            requestCount += 1;
            requests.push(JSON.parse(String(init?.body)) as (typeof requests)[number]);
            if (requestCount === 1) {
                return sse([
                    {
                        type: 'response.output_item.done',
                        item: { type: 'function_call', call_id: 'call_get_answer', name: 'get_answer', arguments: '{}' },
                    },
                    {
                        type: 'response.completed',
                        response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
                    },
                ]);
            }
            return sse(finalAnswer('the answer is 42'));
        };

        const agent = createTestAgent(createTestClient(fetchMock), { model: 'test-model', extensions: runner });
        for await (const _event of agent.stream('what is the answer?')) {
            // Drain.
        }

        assert.ok(requests[0]?.tools?.some((tool) => tool.name === 'get_answer'));
        const secondInput = (requests[1]?.input ?? []) as Array<{ type?: string; output?: string }>;
        assert.ok(secondInput.some((item) => item.type === 'function_call_output' && item.output === '42'));
    } finally {
        if (realHome === undefined) delete process.env.HOME;
        else process.env.HOME = realHome;
        rmSync(dir, { recursive: true, force: true });
    }
});
