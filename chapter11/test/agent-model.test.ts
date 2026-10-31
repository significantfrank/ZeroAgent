import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/agent-loop.ts';
import { ModelRegistry } from '../src/model/index.ts';
import { runSubAgent, type AgentDefinition } from '../src/subagent/index.ts';
import { createTestClient } from './helpers.ts';

function sse(events: readonly Record<string, unknown>[]): Response {
    const body = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function finalResponse(text: string): Response {
    return sse([
        {
            type: 'response.output_item.done',
            item: {
                type: 'message',
                phase: 'final_answer',
                content: [{ type: 'output_text', text }],
            },
        },
        {
            type: 'response.completed',
            response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        },
    ]);
}

type RequestBody = {
    model: string;
    reasoning?: { effort?: string; summary?: string };
    max_output_tokens?: number;
};

function makeRegistry(): ModelRegistry {
    const registry = new ModelRegistry();
    registry.registerProvider('deepseek', { baseUrl: 'https://api.deepseek.com/v1', type: 'api_key', key: 'sk-d' });
    registry.registerProvider('glm', { baseUrl: 'https://open.bigmodel.cn/api/v1', type: 'api_key', key: 'sk-g' });
    return registry;
}

function makeAgent(registry: ModelRegistry, model: string, bodies: RequestBody[]): Agent {
    const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        bodies.push(JSON.parse(String(init?.body)) as RequestBody);
        return finalResponse('ok');
    };
    return new Agent(createTestClient(fetchMock, (model) => registry.resolveAuth(model)), {
        model,
        modelRegistry: registry,
    });
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
    for await (const _ of iterable) { /* consume */ }
}

function subagentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
    return {
        name: 'review',
        description: 'Review.',
        mode: 'subagent',
        systemPrompt: 'Review carefully.',
        ...overrides,
    };
}

test('setModel changes the model used by subsequent streams', async () => {
    const registry = makeRegistry();
    registry.registerModel({ id: 'deepseek-flash', provider: 'deepseek' });
    registry.registerModel({ id: 'glm-5.3', provider: 'glm' });

    const bodies: RequestBody[] = [];
    const agent = makeAgent(registry, 'deepseek-flash', bodies);
    await drain(agent.stream('hi'));
    agent.setModel('glm-5.3');
    await drain(agent.stream('hi'));

    assert.equal(bodies[0]?.model, 'deepseek-flash');
    assert.equal(bodies[1]?.model, 'glm-5.3');
});

test('setThinkingLevel changes the default effort used by subsequent streams', async () => {
    const registry = makeRegistry();
    registry.registerModel({ id: 'thinking', provider: 'deepseek', reasoning: true });

    const bodies: RequestBody[] = [];
    const agent = makeAgent(registry, 'thinking', bodies);
    agent.setThinkingLevel('low');
    await drain(agent.stream('hi'));

    assert.equal(bodies[0]?.reasoning?.effort, 'low');
});

test('constructor thinkingLevel option sets the initial effort', async () => {
    const registry = makeRegistry();
    registry.registerModel({ id: 'thinking', provider: 'deepseek', reasoning: true });

    const bodies: RequestBody[] = [];
    const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        bodies.push(JSON.parse(String(init?.body)) as RequestBody);
        return finalResponse('ok');
    };
    const agent = new Agent(createTestClient(fetchMock, (model) => registry.resolveAuth(model)), {
        model: 'thinking',
        modelRegistry: registry,
        thinkingLevel: 'max',
    });
    await drain(agent.stream('hi'));

    assert.equal(bodies[0]?.reasoning?.effort, 'max');
});

test('reasoning true includes the reasoning field', async () => {
    const registry = makeRegistry();
    registry.registerModel({ id: 'thinking', provider: 'deepseek', reasoning: true });

    const bodies: RequestBody[] = [];
    const agent = makeAgent(registry, 'thinking', bodies);
    await drain(agent.stream('hi', { reasoning: { effort: 'high' } }));

    assert.equal(bodies[0]?.reasoning?.effort, 'high');
});

test('thinkingLevelMap translates the requested effort directly', async () => {
    const registry = makeRegistry();
    registry.registerModel({
        id: 'deepseek-flash',
        provider: 'deepseek',
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
    });

    const bodies: RequestBody[] = [];
    const agent = makeAgent(registry, 'deepseek-flash', bodies);
    await drain(agent.stream('hi', { reasoning: { effort: 'high' } }));

    assert.equal(bodies[0]?.reasoning?.effort, 'high');
});

test('thinkingLevelMap translates to a provider-specific value', async () => {
    const registry = makeRegistry();
    registry.registerModel({
        id: 'custom',
        provider: 'deepseek',
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'xhigh', max: 'max' },
    });

    const bodies: RequestBody[] = [];
    const agent = makeAgent(registry, 'custom', bodies);
    await drain(agent.stream('hi', { reasoning: { effort: 'high' } }));

    assert.equal(bodies[0]?.reasoning?.effort, 'xhigh');
});

test('thinkingLevelMap falls back to the highest available level below the requested level', async () => {
    const registry = makeRegistry();
    registry.registerModel({
        id: 'custom',
        provider: 'deepseek',
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: null, max: 'max' },
    });

    const bodies: RequestBody[] = [];
    const agent = makeAgent(registry, 'custom', bodies);
    await drain(agent.stream('hi', { reasoning: { effort: 'high' } }));

    assert.equal(bodies[0]?.reasoning?.effort, 'low');
});

test('thinkingLevelMap falls back up to the lowest available level', async () => {
    const registry = makeRegistry();
    registry.registerModel({
        id: 'custom',
        provider: 'deepseek',
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: null, medium: null, high: null, max: 'max' },
    });

    const bodies: RequestBody[] = [];
    const agent = makeAgent(registry, 'custom', bodies);
    await drain(agent.stream('hi', { reasoning: { effort: 'high' } }));

    assert.equal(bodies[0]?.reasoning?.effort, 'max');
});

test('model without a level map sends the canonical effort unchanged', async () => {
    const registry = makeRegistry();
    registry.registerModel({ id: 'plain', provider: 'deepseek', reasoning: true });

    const bodies: RequestBody[] = [];
    const agent = makeAgent(registry, 'plain', bodies);
    await drain(agent.stream('hi', { reasoning: { effort: 'high' } }));

    assert.equal(bodies[0]?.reasoning?.effort, 'high');
});

test('maxTokens is forwarded as max_output_tokens', async () => {
    const registry = makeRegistry();
    registry.registerModel({ id: 'deepseek-flash', provider: 'deepseek', maxTokens: 384000 });

    const bodies: RequestBody[] = [];
    const agent = makeAgent(registry, 'deepseek-flash', bodies);
    await drain(agent.stream('hi'));

    assert.equal(bodies[0]?.max_output_tokens, 384000);
});

test('subagent model override fails for an unknown model', async () => {
    const registry = makeRegistry();
    registry.registerModel({ id: 'deepseek-flash', provider: 'deepseek' });

    const agent = makeAgent(registry, 'deepseek-flash', []);
    await assert.rejects(
        () => runSubAgent(agent, 'Review this.', subagentDefinition({ model: 'no-such-model' })),
        /Unknown model "no-such-model"/,
    );
});

test('subagent model override is used for the subagent requests', async () => {
    const registry = makeRegistry();
    registry.registerModel({ id: 'deepseek-flash', provider: 'deepseek' });

    const bodies: RequestBody[] = [];
    const agent = makeAgent(registry, 'deepseek-flash', bodies);
    const result = await runSubAgent(agent, 'Review this.', subagentDefinition({ model: 'deepseek-flash', tools: {} }));

    assert.equal(result, 'ok');
    assert.equal(bodies[0]?.model, 'deepseek-flash');
});
