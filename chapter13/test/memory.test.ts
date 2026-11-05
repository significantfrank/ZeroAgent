import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiClient, AiRequest } from '../src/ai/ai-client.ts';
import { Agent } from '../src/agent/agent-loop.ts';
import { ExtensionRunner } from '../src/extension/runner.ts';
import { HindsightMemoryProvider } from '../src/memory/hindsight-provider.ts';
import { registerMemoryExtension } from '../src/memory/memory-extension.ts';
import type { MemoryProvider } from '../src/memory/memory-provider.ts';

test('HindsightMemoryProvider maps retain and recall to its configured bank', async () => {
    const calls: string[] = [];
    const provider = new HindsightMemoryProvider({ bankId: 'test-bank' }, {
        async retain(bankId, content) {
            calls.push(`retain:${bankId}:${content}`);
            return { success: true };
        },
        async recall(bankId, query) {
            calls.push(`recall:${bankId}:${query}`);
            return { results: [{ text: 'Alice is a software engineer at Google.' }] };
        },
    });

    await provider.retain('User: Hi\nAssistant: Hello');
    const memories = await provider.recall('What does Alice do?');

    assert.deepEqual(calls, [
        'retain:test-bank:User: Hi\nAssistant: Hello',
        'recall:test-bank:What does Alice do?',
    ]);
    assert.deepEqual(memories, ['Alice is a software engineer at Google.']);
});

test('HindsightMemoryProvider defaults to the zeroagent bank', async () => {
    const originalBankId = process.env.HINDSIGHT_BANK_ID;
    delete process.env.HINDSIGHT_BANK_ID;
    try {
        let requestedBank = '';
        const provider = new HindsightMemoryProvider({}, {
            async retain(bankId) {
                requestedBank = bankId;
                return { success: true };
            },
            async recall(bankId) {
                requestedBank = bankId;
                return { results: [] };
            },
        });
        await provider.recall('hello');
        assert.equal(requestedBank, 'zeroagent');
    } finally {
        if (originalBankId === undefined) delete process.env.HINDSIGHT_BANK_ID;
        else process.env.HINDSIGHT_BANK_ID = originalBankId;
    }
});

test('Agent recalls before requesting and retains only a final assistant turn', async () => {
    const requests: AiRequest[] = [];
    const client: AiClient = {
        async *stream(request) {
            requests.push(request);
            if (requests.length === 1) {
                yield { type: 'start' };
                yield {
                    type: 'toolcall_end',
                    toolCall: { id: 'tool-1', name: 'lookup', arguments: '{}' },
                };
                yield { type: 'done', reason: 'tool_calls' };
                return;
            }
            yield { type: 'start' };
            yield { type: 'text_end', content: 'Alice is a software engineer at Google.' };
            yield { type: 'done', reason: 'complete' };
        },
    };
    const retained: string[] = [];
    const recalled: string[] = [];
    const memoryProvider: MemoryProvider = {
        async recall(query) {
            recalled.push(query);
            return ['Alice works at Google.'];
        },
        async retain(content) {
            retained.push(content);
        },
    };
    const extensions = new ExtensionRunner();
    registerMemoryExtension(extensions, memoryProvider);
    const agent = new Agent(client, { model: 'test-model', extensions });
    const events = [];
    for await (const event of agent.stream('Tell me about Alice')) {
        await extensions.emit(event, { input: 'Tell me about Alice' });
        events.push(event);
    }

    assert.deepEqual(recalled, ['Tell me about Alice']);
    assert.ok(requests[0]?.instructions?.includes('Relevant long-term memories:\n- Alice works at Google.'));
    assert.equal(retained.length, 1);
    assert.equal(retained[0], 'User: Tell me about Alice\nAssistant: Alice is a software engineer at Google.');
    const turnEnds = events.filter((event) => event.type === 'turn_end');
    assert.equal(turnEnds.length, 2);
    assert.ok(turnEnds[0]?.message.role === 'assistant' && turnEnds[0].message.toolCalls?.length);
});

test('memory failures do not fail the Agent response', async () => {
    const client: AiClient = {
        async *stream() {
            yield { type: 'start' };
            yield { type: 'text_end', content: 'Answer' };
            yield { type: 'done', reason: 'complete' };
        },
    };
    const memoryProvider: MemoryProvider = {
        async recall() {
            throw new Error('memory offline');
        },
        async retain() {
            throw new Error('memory write failed');
        },
    };
    const extensions = new ExtensionRunner();
    registerMemoryExtension(extensions, memoryProvider);
    const agent = new Agent(client, { model: 'test-model', extensions });
    const events = [];
    for await (const event of agent.stream('Question')) {
        await extensions.emit(event, { input: 'Question' });
        events.push(event);
    }

    assert.ok(events.some((event) => event.type === 'agent_end' && event.message.content === 'Answer'));
    assert.ok(!events.some((event) => event.type === 'error'));
});
