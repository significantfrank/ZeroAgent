import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { SessionStore } from '../src/session/store.ts';
import { SessionManager } from '../src/session/manager.ts';
import { AgentBridge } from '../src/agent/agent-bridge.ts';
import type { AgentEvent } from '../src/agent/types.ts';

function mkdtempSync(prefix: string): string {
    const dir = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

test('AgentBridge persists user message on agent_start and assistant on final turn_end', async () => {
    const dir = mkdtempSync('za-bridge-');
    try {
        const manager = new SessionManager(new SessionStore(join(dir, 'sessions.db')));
        const session = manager.createSession('/workspace');
        const bridge = new AgentBridge(manager, session.id, 'Hello');

        const events: AgentEvent[] = [
            { type: 'agent_start' },
            { type: 'turn_start' },
            { type: 'message_start' },
            { type: 'message_update', aiEvent: { type: 'text_delta', delta: 'Hi there' } },
            { type: 'message_update', aiEvent: { type: 'text_end', content: 'Hi there' } },
            { type: 'message_end' },
            { type: 'turn_end', message: { role: 'assistant', content: 'Hi there' }, toolResults: [] },
            { type: 'agent_end', message: { role: 'assistant', content: 'Hi there' } },
        ];

        for (const event of events) {
            await bridge.handleAgentEvent(event);
        }

        const messages = manager.getMessages(session.id);
        assert.equal(messages.length, 2);
        assert.equal(messages[0]?.role, 'user');
        assert.equal(messages[0]?.content, 'Hello');
        assert.equal(messages[1]?.role, 'assistant');
        assert.equal(messages[1]?.content, 'Hi there');

        manager.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('AgentBridge does not persist assistant message on error turn', async () => {
    const dir = mkdtempSync('za-bridge-err-');
    try {
        const manager = new SessionManager(new SessionStore(join(dir, 'sessions.db')));
        const session = manager.createSession('/workspace');
        const bridge = new AgentBridge(manager, session.id, 'Hello');

        const events: AgentEvent[] = [
            { type: 'agent_start' },
            { type: 'turn_start' },
            { type: 'message_start' },
            { type: 'error', reason: 'Provider down' },
            { type: 'message_end' },
            { type: 'turn_end', message: { role: 'assistant', content: 'Partial' }, toolResults: [] },
            { type: 'agent_end', message: { role: 'assistant', content: 'Partial' } },
        ];

        for (const event of events) {
            await bridge.handleAgentEvent(event);
        }

        const messages = manager.getMessages(session.id);
        assert.equal(messages.length, 1); // only user message
        assert.equal(messages[0]?.role, 'user');
        assert.equal(messages[0]?.content, 'Hello');

        manager.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('AgentBridge does not persist assistant message on tool-call turn', async () => {
    const dir = mkdtempSync('za-bridge-tool-');
    try {
        const manager = new SessionManager(new SessionStore(join(dir, 'sessions.db')));
        const session = manager.createSession('/workspace');
        const bridge = new AgentBridge(manager, session.id, 'Check weather');

        const events: AgentEvent[] = [
            { type: 'agent_start' },
            { type: 'turn_start' },
            { type: 'message_start' },
            { type: 'message_update', aiEvent: { type: 'toolcall_end', toolCall: { id: 'c1', name: 'get_weather', arguments: '{}' } } },
            { type: 'message_end' },
            { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'get_weather', args: {} },
            { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'get_weather', result: 'sunny', isError: false },
            { type: 'turn_end', message: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: '{}' }] }, toolResults: [{ role: 'toolResult', toolCallId: 'c1', toolName: 'get_weather', content: 'sunny', isError: false }] },
            { type: 'agent_end', message: { role: 'assistant', content: '' } },
        ];

        for (const event of events) {
            await bridge.handleAgentEvent(event);
        }

        const messages = manager.getMessages(session.id);
        assert.equal(messages.length, 1); // only user message, no assistant (tool-call turn)
        assert.equal(messages[0]?.role, 'user');

        manager.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
