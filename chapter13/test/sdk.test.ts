import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AiClient, AiEvent, AiRequest } from '../src/ai/ai-client.ts';
import {
    AgentTool,
    FunctionTool,
    LlmAgent,
    OpenAICompatibleLlm,
    ParallelAgent,
    SequentialAgent,
} from '../src/index.ts';
import type {
    AgentRunOptions,
    AgentResult,
    LanguageModel,
    RunnableAgent,
} from '../src/index.ts';

type ScriptedResponse = (request: AiRequest) => AiEvent[];

class ScriptedModel implements LanguageModel {
    readonly model = 'test-model';
    readonly requests: AiRequest[] = [];
    readonly #script: ScriptedResponse;
    readonly #client: AiClient;

    constructor(script: ScriptedResponse) {
        this.#script = script;
        const model = this;
        this.#client = {
            stream: async function* (request) {
                model.requests.push(request);
                yield* model.#script(request);
            },
        };
    }

    createClient(): AiClient {
        return this.#client;
    }
}

test('LlmAgent executes a JSON Schema FunctionTool and applies its instruction', async () => {
    let responseCount = 0;
    const model = new ScriptedModel((request) => {
        responseCount += 1;
        if (responseCount === 1) {
            return [
                { type: 'start' },
                {
                    type: 'toolcall_end',
                    toolCall: {
                        id: 'call-time',
                        name: 'get_current_time',
                        arguments: '{"city":"Tokyo"}',
                    },
                },
                { type: 'done', reason: 'completed' },
            ];
        }
        return [
            { type: 'start' },
            { type: 'text_end', content: '10:30 AM in Tokyo' },
            { type: 'done', reason: 'completed' },
        ];
    });
    const tool = new FunctionTool({
        name: 'get_current_time',
        description: 'Get the current time in a city.',
        parameters: { city: 'The name of the city.' },
        execute: ({ city }) => ({ city, time: '10:30 AM' }),
    });
    const agent = new LlmAgent({
        name: 'clock',
        model,
        instruction: 'Use the time tool when asked.',
        tools: [tool],
    });

    const result = await agent.run('What time is it in Tokyo?');

    assert.equal(result.output, '10:30 AM in Tokyo');
    assert.equal(model.requests.length, 2);
    assert.equal(model.requests[0]?.instructions, 'Use the time tool when asked.');
    assert.deepEqual(model.requests[0]?.tools?.[0]?.parameters, {
        type: 'object',
        properties: { city: { type: 'string', description: 'The name of the city.' } },
        required: ['city'],
    });
    const toolResult = model.requests[1]?.input;
    assert.ok(Array.isArray(toolResult));
    assert.deepEqual(toolResult.at(-1), {
        type: 'tool_result',
        toolCallId: 'call-time',
        content: '{"city":"Tokyo","time":"10:30 AM"}',
    });
});

test('OpenAICompatibleLlm runs through the public SDK with explicit credentials', async () => {
    let authorization: string | null = null;
    let requestedUrl = '';
    const model = new OpenAICompatibleLlm({
        model: 'test-model',
        baseURL: 'https://provider.test/v1',
        apiKey: 'test-key',
        fetch: async (input, init) => {
            requestedUrl = String(input);
            authorization = new Headers(init?.headers).get('authorization');
            return new Response([
                'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"hello from model"}]}}',
                'data: {"type":"response.completed","response":{"status":"completed"}}',
                '',
            ].join('\n\n'), {
                headers: { 'content-type': 'text/event-stream' },
            });
        },
    });
    const agent = new LlmAgent({ name: 'hello', model });

    const result = await agent.run('hello');

    assert.equal(result.output, 'hello from model');
    assert.equal(authorization, 'Bearer test-key');
    assert.match(requestedUrl, /\/responses$/);
});

test('OpenAICompatibleLlm loads credentials from .env in the working directory', async () => {
    const originalCwd = process.cwd();
    const originalApiKey = process.env.OPENAI_API_KEY;
    const originalBaseUrl = process.env.OPENAI_BASE_URL;
    const dir = mkdtempSync(join(tmpdir(), 'zero-agent-sdk-env-'));
    try {
        delete process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_BASE_URL;
        writeFileSync(join(dir, '.env'), [
            'OPENAI_API_KEY=dotenv-test-key',
            'OPENAI_BASE_URL=https://dotenv-provider.test/v1',
            '',
        ].join('\n'));
        process.chdir(dir);

        let requestedUrl = '';
        const model = new OpenAICompatibleLlm({
            model: 'test-model',
            fetch: async (input) => {
                requestedUrl = String(input);
                return new Response([
                    'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"loaded"}]}}',
                    'data: {"type":"response.completed","response":{"status":"completed"}}',
                    '',
                ].join('\n\n'), {
                    headers: { 'content-type': 'text/event-stream' },
                });
            },
        });
        const agent = new LlmAgent({ name: 'dotenv', model });

        const result = await agent.run('hello');

        assert.equal(result.output, 'loaded');
        assert.match(requestedUrl, /^https:\/\/dotenv-provider\.test\/v1\/responses$/);
        assert.equal(process.env.OPENAI_API_KEY, 'dotenv-test-key');
    } finally {
        process.chdir(originalCwd);
        if (originalApiKey === undefined) {
            delete process.env.OPENAI_API_KEY;
        } else {
            process.env.OPENAI_API_KEY = originalApiKey;
        }
        if (originalBaseUrl === undefined) {
            delete process.env.OPENAI_BASE_URL;
        } else {
            process.env.OPENAI_BASE_URL = originalBaseUrl;
        }
        rmSync(dir, { recursive: true, force: true });
    }
});

test('AgentTool delegates the task to its agent', async () => {
    const delegated: string[] = [];
    const child: RunnableAgent = {
        name: 'researcher',
        async run(input: string): Promise<AgentResult> {
            delegated.push(input);
            return { name: this.name, output: 'research complete' };
        },
    };
    const tool = new AgentTool(child);

    const output = await tool.execute({ task: 'find sources' });

    assert.equal(tool.name, 'researcher');
    assert.equal(output, 'research complete');
    assert.deepEqual(delegated, ['find sources']);
});

test('SequentialAgent forwards previous results and returns the final result', async () => {
    const inputs: string[] = [];
    const agents: RunnableAgent[] = ['planner', 'writer'].map((name) => ({
        name,
        async run(input: string): Promise<AgentResult> {
            inputs.push(input);
            return { name, output: `${name} output` };
        },
    }));
    const workflow = new SequentialAgent({ name: 'pipeline', agents });

    const result = await workflow.run('write an update');

    assert.equal(result.output, 'writer output');
    assert.equal(result.children?.length, 2);
    assert.equal(inputs[0], 'write an update');
    assert.match(inputs[1]!, /Original task:\nwrite an update/);
    assert.match(inputs[1]!, /Previous step \(planner\) result:\nplanner output/);
});

test('ParallelAgent starts all agents concurrently and keeps declaration order', async () => {
    let started = 0;
    let release!: () => void;
    const allStarted = new Promise<void>((resolve) => {
        release = resolve;
    });
    const agents: RunnableAgent[] = ['first', 'second'].map((name) => ({
        name,
        async run(input: string, _options?: AgentRunOptions): Promise<AgentResult> {
            started += 1;
            if (started === 2) release();
            await allStarted;
            return { name, output: `${input}:${name}` };
        },
    }));
    const workflow = new ParallelAgent({ name: 'parallel', agents });

    const result = await workflow.run('task');

    assert.deepEqual(result.children?.map((child) => child.name), ['first', 'second']);
    assert.equal(result.output, '## first\ntask:first\n\n## second\ntask:second');
});

test('ParallelAgent aborts sibling agents when a branch fails', async () => {
    let siblingAborted = false;
    const agents: RunnableAgent[] = [
        {
            name: 'waiting',
            run: (_input, options) => new Promise<AgentResult>((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => {
                    siblingAborted = true;
                    reject(options.signal?.reason);
                }, { once: true });
            }),
        },
        {
            name: 'failing',
            async run(): Promise<AgentResult> {
                await Promise.resolve();
                throw new Error('branch failed');
            },
        },
    ];
    const workflow = new ParallelAgent({ name: 'parallel', agents });

    await assert.rejects(workflow.run('task'), /branch failed/);
    assert.equal(siblingAborted, true);
});
