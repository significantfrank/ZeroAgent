import { randomUUID } from 'node:crypto';
import { SessionStore } from './store.ts';
import type { SessionRow, MessageRow, SessionMeta } from './types.ts';

/**
 * High-level session management API.
 *
 * Wraps {@link SessionStore} with domain-friendly methods used by the
 * agent loop and CLI. Tracks the "active" session and provides
 * convenience operations like auto-title generation.
 */
export class SessionManager {
    readonly #store: SessionStore;

    constructor(store?: SessionStore) {
        this.#store = store ?? new SessionStore();
    }

    get store(): SessionStore {
        return this.#store;
    }

    // -----------------------------------------------------------------------
    // Session operations
    // -----------------------------------------------------------------------

    /**
     * Create a new session for the given workspace.
     */
    createSession(workspace: string, model?: string): SessionRow {
        const now = new Date().toISOString();
        const id = randomUUID();
        const session: SessionRow = {
            id,
            title: '',
            model: model ?? '',
            workspace,
            parentSessionId: null,
            createdAt: now,
            updatedAt: now,
        };
        this.#store.insertSession({
            id: session.id,
            model: session.model,
            workspace: session.workspace,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
        });
        return session;
    }

    /**
     * Get a session with its message count, or `undefined`.
     */
    getSession(id: string): SessionMeta | undefined {
        const row = this.#store.getSessionById(id);
        if (row === undefined) return undefined;
        return {
            ...row,
            messageCount: this.#store.getMessageCountBySessionId(id),
        };
    }

    /**
     * List all sessions, optionally filtered by workspace.
     * Returns metadata with message counts, sorted by `updatedAt` descending.
     */
    listSessions(workspace?: string): SessionMeta[] {
        const sessions = workspace !== undefined
            ? this.#store.getSessionsByWorkspace(workspace)
            : this.#store.getAllSessions();
        return sessions.map((s) => ({
            ...s,
            messageCount: this.#store.getMessageCountBySessionId(s.id),
        }));
    }

    /**
     * Delete a session and all its messages.
     * Returns `true` if the session existed, `false` otherwise.
     */
    deleteSession(id: string): boolean {
        return this.#store.deleteSession(id);
    }

    /**
     * Get the most recently updated session for a workspace, or `undefined`.
     */
    getLatestSessionByWorkspace(workspace: string): SessionRow | undefined {
        const sessions = this.#store.getSessionsByWorkspace(workspace);
        return sessions[0];
    }

    // -----------------------------------------------------------------------
    // Message operations
    // -----------------------------------------------------------------------

    /**
     * Append a message to a session.
     * Sets the session title from the first user message if title is empty.
     */
    appendMessage(sessionId: string, role: string, content: string): MessageRow {
        const msg = this.#store.insertMessage({ sessionId, role, content });
        this.#store.updateSessionTimestamp(sessionId);

        // Auto-set title from first user message
        const session = this.#store.getSessionById(sessionId);
        if (session !== undefined && session.title === '' && role === 'user') {
            const title = content.length > 50 ? content.slice(0, 50) : content;
            this.#store.updateSessionTitle(sessionId, title);
        }

        return msg;
    }

    /**
     * Get all messages for a session, ordered by creation time ascending.
     */
    getMessages(sessionId: string): MessageRow[] {
        return this.#store.getMessagesBySessionId(sessionId);
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    close(): void {
        this.#store.close();
    }
}
