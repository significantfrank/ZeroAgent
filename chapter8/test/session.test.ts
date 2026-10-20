import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { SessionStore } from '../src/session/store.ts';
import { SessionManager } from '../src/session/manager.ts';
import { Agent } from '../src/agent-loop.ts';
import { ResponsesClient } from '../src/client.ts';
import type { AgentEvent } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sse(events: readonly Record<string, unknown>[]): Response {
    const body = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function makeDbPath(dir: string): string {
    return join(dir, 'test-sessions.db');
}

// ---------------------------------------------------------------------------
// SessionStore tests
// ---------------------------------------------------------------------------

test('SessionStore creates database and schema on first use', () => {
    const dir = mkdtempSync(join(tmpdir(), 'za-store-'));
    try {
        const store = new SessionStore(makeDbPath(dir));
        // If schema was created, we can insert without error
        const now = new Date().toISOString();
        store.insertSession({
            id: 'test-1',
            model: 'gpt-4o-mini',
            workspace: '/projects/foo',
            createdAt: now,
            updatedAt: now,
        });
        const session = store.getSessionById('test-1');
        assert.ok(session !== undefined);
        assert.equal(session.id, 'test-1');
        assert.equal(session.workspace, '/projects/foo');
        assert.equal(session.title, '');
        store.close();
    } finally {
        rmSync(dir);
    }
});

test('SessionStore migration is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'za-store-idem-'));
    try {
        const dbPath = makeDbPath(dir);
        const store1 = new SessionStore(dbPath);
        const now = new Date().toISOString();
        store1.insertSession({ id: 's1', model: '', workspace: '/w', createdAt: now, updatedAt: now });
        store1.close();

        // Reopen — should not error, data should be preserved
        const store2 = new SessionStore(dbPath);
        const session = store2.getSessionById('s1');
        assert.ok(session !== undefined);
        assert.equal(session.id, 's1');
        store2.close();
    } finally {
        rmSync(dir);
    }
});

test('SessionStore session CRUD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'za-store-crud-'));
    try {
        const store = new SessionStore(makeDbPath(dir));
        const now = new Date().toISOString();

        // Insert
        store.insertSession({ id: 'a', model: 'm1', workspace: '/w', createdAt: now, updatedAt: now });
        store.insertSession({ id: 'b', model: 'm2', workspace: '/w', createdAt: now, updatedAt: now });

        // Get by ID
        assert.ok(store.getSessionById('a') !== undefined);
        assert.equal(store.getSessionById('nonexistent'), undefined);

        // Update title
        store.updateSessionTitle('a', 'My Session');
        assert.equal(store.getSessionById('a')?.title, 'My Session');

        // Update timestamp
        const originalUpdatedAt = store.getSessionById('b')?.updatedAt;
        store.updateSessionTimestamp('b');
        const newUpdatedAt = store.getSessionById('b')?.updatedAt;
        assert.ok(newUpdatedAt !== originalUpdatedAt);

        // Get by workspace (sorted by updated_at DESC)
        const sessions = store.getSessionsByWorkspace('/w');
        assert.equal(sessions.length, 2);
        // 'b' was just touched, should be first
        assert.equal(sessions[0]?.id, 'b');

        // Delete cascades to messages
        store.insertMessage({ sessionId: 'a', role: 'user', content: 'hello' });
        assert.equal(store.getMessageCountBySessionId('a'), 1);
        const deleted = store.deleteSession('a');
        assert.equal(deleted, true);
        assert.equal(store.getSessionById('a'), undefined);
        assert.equal(store.getMessageCountBySessionId('a'), 0);

        // Delete non-existent
        assert.equal(store.deleteSession('nonexistent'), false);

        store.close();
    } finally {
        rmSync(dir);
    }
});

test('SessionStore message CRUD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'za-store-msg-'));
    try {
        const store = new SessionStore(makeDbPath(dir));
        const now = new Date().toISOString();
        store.insertSession({ id: 's1', model: '', workspace: '/w', createdAt: now, updatedAt: now });

        // Insert messages
        const m1 = store.insertMessage({ sessionId: 's1', role: 'user', content: 'Hello' });
        const m2 = store.insertMessage({ sessionId: 's1', role: 'assistant', content: 'Hi there' });
        assert.ok(m1.id !== m2.id);
        assert.equal(m1.role, 'user');
        assert.equal(m1.content, 'Hello');

        // Get messages ordered by created_at ASC
        const messages = store.getMessagesBySessionId('s1');
        assert.equal(messages.length, 2);
        assert.equal(messages[0]?.content, 'Hello');
        assert.equal(messages[1]?.content, 'Hi there');

        // Count
        assert.equal(store.getMessageCountBySessionId('s1'), 2);

        // Empty for non-existent session
        assert.deepEqual(store.getMessagesBySessionId('nonexistent'), []);
        assert.equal(store.getMessageCountBySessionId('nonexistent'), 0);

        store.close();
    } finally {
        rmSync(dir);
    }
});

test('SessionStore close prevents further operations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'za-store-close-'));
    try {
        const store = new SessionStore(makeDbPath(dir));
        store.close();
        assert.throws(() => store.getSessionById('x'));
    } finally {
        rmSync(dir);
    }
});

// ---------------------------------------------------------------------------
// SessionManager tests
// ---------------------------------------------------------------------------

test('SessionManager createSession returns session with UUID', () => {
    const dir = mkdtempSync(join(tmpdir(), 'za-mgr-create-'));
    try {
        const manager = new SessionManager(new SessionStore(makeDbPath(dir)));
        const session = manager.createSession('/workspace', 'gpt-4o-mini');
        assert.ok(session.id.length > 0);
        assert.equal(session.workspace, '/workspace');
        assert.equal(session.model, 'gpt-4o-mini');
        assert.equal(session.title, '');
        manager.close();
    } finally {
        rmSync(dir);
    }
});

test('SessionManager appendMessage with auto-title', () => {
    const dir = mkdtempSync(join(tmpdir(), 'za-mgr-title-'));
    try {
        const manager = new SessionManager(new SessionStore(makeDbPath(dir)));
        const session = manager.createSession('/workspace');

        // First user message sets title
        manager.appendMessage(session.id, 'user', 'What is the weather in Tokyo?');
        const updated = manager.getSession(session.id);
        assert.equal(updated?.title, 'What is the weather in Tokyo?');

        // Long message gets truncated to 50 chars
        const session2 = manager.createSession('/workspace');
        const longMsg = 'A'.repeat(100);
        manager.appendMessage(session2.id, 'user', longMsg);
        const updated2 = manager.getSession(session2.id);
        assert.equal(updated2?.title.length, 50);

        manager.close();
    } finally {
        rmSync(dir);
    }
});

test('SessionManager getMessages returns history in order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'za-mgr-msgs-'));
    try {
        const manager = new SessionManager(new SessionStore(makeDbPath(dir)));
        const session = manager.createSession('/workspace');

        manager.appendMessage(session.id, 'user', 'Hello');
        manager.appendMessage(session.id, 'assistant', 'Hi');
        manager.appendMessage(session.id, 'user', 'How are you?');

        const messages = manager.getMessages(session.id);
        assert.equal(messages.length, 3);
        assert.equal(messages[0]?.role, 'user');
        assert.equal(messages[0]?.content, 'Hello');
        assert.equal(messages[1]?.role, 'assistant');
        assert.equal(messages[2]?.content, 'How are you?');

        manager.close();
    } finally {
        rmSync(dir);
    }
});

test('SessionManager getLatestSessionByWorkspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'za-mgr-latest-'));
    try {
        const manager = new SessionManager(new SessionStore(makeDbPath(dir)));

        // No sessions → undefined
        assert.equal(manager.getLatestSessionByWorkspace('/w'), undefined);

        const s1 = manager.createSession('/w');
        const s2 = manager.createSession('/w');

        // s2 was created later, but both have very close timestamps.
        // Append a message to s1 to make its updated_at newer
        manager.appendMessage(s1.id, 'user', 'Hello');

        const latest = manager.getLatestSessionByWorkspace('/w');
        assert.ok(latest !== undefined);
        assert.equal(latest.id, s1.id);

        // Different workspace
        assert.equal(manager.getLatestSessionByWorkspace('/other'), undefined);

        manager.close();
    } finally {
        rmSync(dir);
    }
});

test('SessionManager listSessions with and without workspace filter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'za-mgr-list-'));
    try {
        const manager = new SessionManager(new SessionStore(makeDbPath(dir)));
        const s1 = manager.createSession('/w1');
        const s2 = manager.createSession('/w2');
        manager.appendMessage(s1.id, 'user', 'msg1');
        manager.appendMessage(s2.id, 'user', 'msg2');

        // Filter by workspace
        const w1Sessions = manager.listSessions('/w1');
        assert.equal(w1Sessions.length, 1);
        assert.equal(w1Sessions[0]?.id, s1.id);
        assert.equal(w1Sessions[0]?.messageCount, 1);

        // All sessions
        const all = manager.listSessions();
        assert.equal(all.length, 2);

        manager.close();
    } finally {
        rmSync(dir);
    }
});

test('SessionManager deleteSession returns true/false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'za-mgr-del-'));
    try {
        const manager = new SessionManager(new SessionStore(makeDbPath(dir)));
        const session = manager.createSession('/w');
        manager.appendMessage(session.id, 'user', 'hello');

        assert.equal(manager.deleteSession(session.id), true);
        assert.equal(manager.getSession(session.id), undefined);
        assert.equal(manager.deleteSession('nonexistent'), false);

        manager.close();
    } finally {
        rmSync(dir);
    }
});

// ---------------------------------------------------------------------------
// Agent + session integration tests
// ---------------------------------------------------------------------------

test('agent with session: multi-turn conversation sends accumulated history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'za-agent-session-'));
    const realHome = process.env.HOME;
    process.env.HOME = dir;
    try {
        const manager = new SessionManager(new SessionStore(join(dir, 'sessions.db')));
        const session = manager.createSession(dir, 'test-model');

        const requests: Array<{ input: unknown[] }> = [];
        let callCount = 0;

        const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            callCount += 1;
            const body = JSON.parse(String(init?.body)) as { input: unknown[] };
            requests.push({ input: body.input });

            // First call: respond with text
            if (callCount === 1) {
                return sse([{
                    type: 'response.output_item.done',
                    item: {
                        type: 'message',
                        phase: 'final_answer',
                        content: [{ type: 'output_text', text: 'Tokyo is cloudy.' }],
                    },
                }]);
            }
            // Second call: respond with text
            return sse([{
                type: 'response.output_item.done',
                item: {
                    type: 'message',
                    phase: 'final_answer',
                    content: [{ type: 'output_text', text: 'London is rainy.' }],
                },
            }]);
        };

        const agent = new Agent(new ResponsesClient({ apiKey: 'test', fetch: fetchMock }), {
            workdir: dir,
            sessionManager: manager,
            sessionId: session.id,
        });

        // First turn
        for await (const _event of agent.stream('What is the weather in Tokyo?')) { void _event; }

        // Second turn — should include history from first turn
        for await (const _event of agent.stream('What about London?')) { void _event; }

        assert.equal(callCount, 2);

        // First request: developer msg + user msg
        const firstInput = requests[0]?.input as Array<{ role?: string; content?: string }>;
        assert.ok(firstInput.some((item) => item.role === 'user' && item.content === 'What is the weather in Tokyo?'));

        // Second request: should contain both user messages and the first assistant response
        const secondInput = requests[1]?.input as Array<{ role?: string; content?: string }>;
        const userMsgs = secondInput.filter((item) => item.role === 'user');
        const assistantMsgs = secondInput.filter((item) => item.role === 'assistant');
        assert.ok(userMsgs.some((m) => m.content === 'What is the weather in Tokyo?'));
        assert.ok(userMsgs.some((m) => m.content === 'What about London?'));
        assert.ok(assistantMsgs.some((m) => m.content === 'Tokyo is cloudy.'));

        // Verify messages were persisted to DB
        const dbMessages = manager.getMessages(session.id);
        assert.equal(dbMessages.length, 4); // 2 user + 2 assistant
        assert.equal(dbMessages[0]?.role, 'user');
        assert.equal(dbMessages[0]?.content, 'What is the weather in Tokyo?');
        assert.equal(dbMessages[1]?.role, 'assistant');
        assert.equal(dbMessages[1]?.content, 'Tokyo is cloudy.');
        assert.equal(dbMessages[2]?.role, 'user');
        assert.equal(dbMessages[2]?.content, 'What about London?');
        assert.equal(dbMessages[3]?.role, 'assistant');
        assert.equal(dbMessages[3]?.content, 'London is rainy.');

        manager.close();
    } finally {
        process.env.HOME = realHome;
        rmSync(dir);
    }
});

test('agent without session: existing behavior unchanged (no regression)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'za-agent-nosession-'));
    const realHome = process.env.HOME;
    process.env.HOME = dir;
    try {
        let callCount = 0;
        const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            callCount += 1;
            return sse([{
                type: 'response.output_item.done',
                item: {
                    type: 'message',
                    phase: 'final_answer',
                    content: [{ type: 'output_text', text: 'Hello!' }],
                },
            }]);
        };

        const agent = new Agent(new ResponsesClient({ apiKey: 'test', fetch: fetchMock }), {
            workdir: dir,
        });

        const events: AgentEvent[] = [];
        for await (const event of agent.stream('Hi')) {
            events.push(event);
        }

        assert.equal(callCount, 1);
        const last = events.at(-1);
        assert.equal(last?.type, 'run_end');
        assert.equal((last as { text: string }).text, 'Hello!');
    } finally {
        process.env.HOME = realHome;
        rmSync(dir);
    }
});

// ---------------------------------------------------------------------------
// Sync helpers (mkdtempSync / rmSync — needed for SQLite sync tests)
// ---------------------------------------------------------------------------

import { mkdirSync as mkdirSyncNode, rmSync as rmSyncNode } from 'node:fs';

function mkdtempSync(prefix: string): string {
    // mkdtemp is async, but we need sync for SQLite tests.
    // Use a simple unique dir name.
    const dir = join(tmpdir(), `${prefix.split('/').pop()}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSyncNode(dir, { recursive: true });
    return dir;
}

function rmSync(dir: string): void {
    rmSyncNode(dir, { recursive: true, force: true });
}
