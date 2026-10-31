import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agent/agent-loop.ts';
import { SessionManager } from '../src/session/manager.ts';
import { SessionStore } from '../src/session/store.ts';
import { ModelRegistry, formatModels, restoreSessionModel, switchModel } from '../src/model/index.ts';
import { createTestClient } from './helpers.ts';

function makeRegistry(): ModelRegistry {
    const registry = new ModelRegistry();
    registry.registerProvider('deepseek', { baseUrl: 'https://api.deepseek.com/v1', type: 'api_key', key: 'sk-d' });
    registry.registerModel({
        id: 'deepseek-flash',
        provider: 'deepseek',
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
    });
    registry.registerModel({ id: 'glm-5.3', provider: 'deepseek' });
    return registry;
}

test('formatModels lists models with active marker, reasoning, and levels', () => {
    const lines = formatModels(makeRegistry(), 'deepseek-flash');

    assert.equal(lines.length, 2);
    assert.ok(lines[0]!.includes('* deepseek-flash'));
    assert.ok(lines[0]!.includes('provider: deepseek'));
    assert.ok(lines[0]!.includes('reasoning: on'));
    assert.ok(lines[0]!.includes('levels: low,high,max'));

    assert.ok(lines[1]!.includes(' glm-5.3'));
    assert.ok(!lines[1]!.includes('*'));
    assert.ok(lines[1]!.includes('reasoning: off'));
    assert.ok(lines[1]!.includes('levels: -'));
});

test('formatModels reports no models configured', () => {
    assert.deepEqual(formatModels(new ModelRegistry(), 'anything'), ['No models configured.']);
});

test('switchModel switches and persists model to the active session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'za-model-cmd-'));
    try {
        const registry = makeRegistry();
        const manager = new SessionManager(new SessionStore(join(dir, 'sessions.db')));
        const session = manager.createSession('/w', 'gpt-4o-mini');
        const agent = new Agent(createTestClient(), {
            modelRegistry: registry,
            sessionManager: manager,
            sessionId: session.id,
        });

        assert.equal(switchModel(agent, registry, manager, 'deepseek-flash'), true);
        assert.equal(agent.model, 'deepseek-flash');
        assert.equal(manager.getSession(session.id)?.model, 'deepseek-flash');

        assert.equal(switchModel(agent, registry, manager, 'no-such-model'), false);
        assert.equal(agent.model, 'deepseek-flash');
        assert.equal(manager.getSession(session.id)?.model, 'deepseek-flash');

        manager.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('restoreSessionModel restores a non-empty model and ignores empty', () => {
    const agent = new Agent(createTestClient(), { model: 'default-model' });

    restoreSessionModel(agent, 'deepseek-flash');
    assert.equal(agent.model, 'deepseek-flash');

    restoreSessionModel(agent, '');
    assert.equal(agent.model, 'deepseek-flash');
});
