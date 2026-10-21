import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agent-loop.ts';
import { ResponsesClient } from '../src/client.ts';
import {
    buildSubagentParentPrompt,
    isSubAgentInput,
    loadAllAgents,
    parseSubAgent,
    parseAgentFile,
    runSubAgent,
    AgentRegistry,
    type AgentDefinition,
} from '../src/subagent/index.ts';
import { fileSearchTool, readFileTool, registerBuiltInToolHandlers, ToolRegistry, writeFileTool } from '../src/tool/index.ts';

function sse(events: readonly Record<string, unknown>[]): Response {
    const body = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
    return {
        name: 'review',
        description: 'Review code changes.',
        mode: 'subagent',
        systemPrompt: 'Review carefully.',
        ...overrides,
    };
}

test('parseAgentFile parses definition metadata and system prompt', () => {
    const agent = parseAgentFile(`---
name: review
description: Review code changes
mode: subagent
model: provider/model
tools:
    read_file: true
    file_search: true
---
Review the requested changes and report findings.
`, 'review.md');

    assert.deepEqual(agent, {
        name: 'review',
        description: 'Review code changes',
        mode: 'subagent',
        model: 'provider/model',
        tools: { read_file: true, file_search: true },
        systemPrompt: 'Review the requested changes and report findings.',
    });
});

test('parseAgentFile rejects invalid names, modes, and tool whitelist values', () => {
    const base = `---\nname: review\ndescription: Review\nmode: subagent\n---\nPrompt`;
    assert.throws(() => parseAgentFile(base.replace('name: review', 'name: CodeReview'), 'bad-name.md'), /kebab-case/);
    assert.throws(() => parseAgentFile(base.replace('mode: subagent', 'mode: agent'), 'bad-mode.md'), /mode: subagent/);
    assert.throws(() => parseAgentFile(`${base.replace('---\nPrompt', 'tools:\n  read_file: yes\n---\nPrompt')}`, 'bad-tools.md'), /expected boolean/);
});

test('project definitions override user definitions with the same name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'za-agent-defs-'));
    const workdir = join(root, 'project');
    const userDir = join(root, 'user-agents');
    const projectDir = join(workdir, '.zeroagent', 'agents');
    await mkdir(userDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    const userDefinition = `---\nname: review\ndescription: User review\nmode: subagent\n---\nUser prompt`;
    const projectDefinition = `---\nname: review\ndescription: Project review\nmode: subagent\n---\nProject prompt`;
    await writeFile(join(userDir, 'review.md'), userDefinition);
    await writeFile(join(projectDir, 'review.md'), projectDefinition);

    try {
        const { registry, loaded } = await loadAllAgents(workdir, userDir);
        assert.equal(loaded.length, 2);
        assert.equal(registry.get('review')?.description, 'Project review');
        assert.equal(registry.get('review')?.systemPrompt, 'Project prompt');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('project .zeroagent/agents definitions load and blank optional model is ignored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'za-agent-flat-'));
    const workdir = join(root, 'project');
    const userDir = join(root, 'user-agents');
    const configDir = join(workdir, '.zeroagent', 'agents');
    await mkdir(userDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'reviewer.md'), `---
name: reviewer
description: Code reviewer
mode: subagent
model:
tools:
    read_file: true
    file_search: true
---
Review the requested code.
`);

    try {
        const { registry } = await loadAllAgents(workdir, userDir);
        assert.equal(registry.get('reviewer')?.name, 'reviewer');
        assert.equal(registry.get('reviewer')?.model, undefined);
        assert.deepEqual(registry.get('reviewer')?.tools, { read_file: true, file_search: true });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('ToolRegistry.copyFrom copies only tool names enabled in AgentDefinition', async () => {
    const source = new ToolRegistry()
        .register(readFileTool, () => 'read')
        .register(fileSearchTool, () => 'search')
        .register(writeFileTool, () => 'write');
    const target = new ToolRegistry().copyFrom(source, definition({
        tools: { read_file: true, file_search: true, write_file: false },
    }));
    const call = (name: string) => ({
        type: 'function_call' as const,
        call_id: `call_${name}`,
        name,
        arguments: '{}',
    });

    assert.equal((await target.execute(call('read_file')))?.output, 'read');
    assert.equal((await target.execute(call('file_search')))?.output, 'search');
    assert.equal(await target.execute(call('write_file')), undefined);
});

test('isSubAgentInput recognizes @-prefixed input', () => {
    assert.equal(isSubAgentInput('@review Inspect this patch'), true);
    assert.equal(isSubAgentInput('Inspect this patch'), false);
});

test('parseSubAgent resolves the definition for @ invocation', () => {
    const registry = new AgentRegistry().register(definition());
    const result = parseSubAgent('@review Inspect this patch', registry);
    assert.deepEqual(result, { task: 'Inspect this patch', definition: definition() });
    const parentPrompt = buildSubagentParentPrompt('review', 'Inspect this patch', 'Two issues found.');
    assert.ok(parentPrompt.includes('Inspect this patch'));
    assert.ok(parentPrompt.includes('Two issues found.'));
    assert.ok(parentPrompt.includes('Use the SubAgent result below to answer the user'));
});

test('parseSubAgent rejects invalid and unknown agents', () => {
    const registry = new AgentRegistry();
    assert.throws(() => parseSubAgent('@bad_name task', registry), /Invalid agent name/);
    assert.throws(() => parseSubAgent('@review task', registry), /Unknown agent: review/);
    registry.register(definition());
    assert.throws(() => parseSubAgent('@review', registry), /Usage: @review <task>/);
});

test('custom subagent applies its prompt and model and runs whitelisted tools', async () => {
    const requests: Array<{
        model: string;
        instructions?: string;
        input: unknown[];
        tools: Array<{ name: string }>;
    }> = [];
    const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requests.push(JSON.parse(String(init?.body)) as typeof requests[number]);
        if (requests.length === 1) {
            return sse([{
                type: 'response.output_item.done',
                item: {
                    type: 'function_call',
                    call_id: 'call_allowed_read',
                    name: 'read_file',
                    arguments: JSON.stringify({ path: 'src/client.ts' }),
                },
            }]);
        }
        return sse([{
            type: 'response.output_item.done',
            item: {
                type: 'message',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'Review complete.' }],
            },
        }]);
    };
    const agent = new Agent(new ResponsesClient({ apiKey: 'test-key', fetch: fetchMock }), { model: 'parent-model' });
    registerBuiltInToolHandlers(agent);
    const rendered: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => rendered.push(args.join(' '));
    let result: string;
    try {
        result = await runSubAgent(
            agent,
            'Review this change.',
            definition({ model: 'review-model', tools: { read_file: true, file_search: true } }),
        );
    } finally {
        console.log = originalLog;
    }

    assert.equal(result, 'Review complete.');
    assert.equal(requests[0]?.model, 'review-model');
    assert.ok(requests[0]?.instructions?.includes('Review carefully.'));
    assert.ok(!requests[0]?.tools.some((tool) => tool.name === 'write_file'));
    assert.ok(requests[0]?.tools.some((tool) => tool.name === 'read_file'));
    assert.ok(requests[0]?.tools.some((tool) => tool.name === 'load_skill'));
    assert.ok(JSON.stringify(requests[1]?.input).includes('1|import OpenAI from'));
    assert.ok(rendered.includes('[review subagent]'));
    assert.ok(rendered.some((line) => line.includes('[tool_call] read_file')));
    assert.ok(rendered.includes('[review subagent end]'));
});