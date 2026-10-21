import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { SessionRow, MessageRow } from './types.ts';

/**
 * Low-level SQLite store for session persistence.
 *
 * Manages the database connection at `~/.zeroagent/sessions.db`,
 * schema migration, and raw CRUD on the `sessions` and `messages` tables.
 * The higher-level {@link SessionManager} wraps this with domain logic.
 */
export class SessionStore {
    readonly #db: DatabaseSync;

    /**
     * Open (or create) the session database at the given path.
     * Defaults to `~/.zeroagent/sessions.db`.
     */
    constructor(dbPath?: string) {
        const path = dbPath ?? defaultDbPath();
        mkdirSync(dirname(path), { recursive: true });
        this.#db = new DatabaseSync(path);
        this.#db.exec('PRAGMA foreign_keys = ON');
        this.#migrate();
    }

    // -----------------------------------------------------------------------
    // Schema
    // -----------------------------------------------------------------------

    #migrate(): void {
        this.#db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                workspace TEXT NOT NULL DEFAULT '',
                parent_session_id TEXT REFERENCES sessions(id),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace);
        `);
    }

    // -----------------------------------------------------------------------
    // Session CRUD
    // -----------------------------------------------------------------------

    insertSession(session: Omit<SessionRow, 'title' | 'parentSessionId'> & Partial<Pick<SessionRow, 'title' | 'parentSessionId'>>): void {
        const now = new Date().toISOString();
        this.#db.prepare(
            'INSERT INTO sessions (id, title, model, workspace, parent_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
            session.id,
            session.title ?? '',
            session.model,
            session.workspace,
            session.parentSessionId ?? null,
            session.createdAt,
            session.updatedAt,
        );
        void now;
    }

    getSessionById(id: string): SessionRow | undefined {
        const row = this.#db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        return row === undefined ? undefined : rowToSession(row);
    }

    updateSessionTitle(id: string, title: string): void {
        const now = new Date().toISOString();
        this.#db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, now, id);
    }

    updateSessionTimestamp(id: string): void {
        const now = new Date().toISOString();
        this.#db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, id);
    }

    deleteSession(id: string): boolean {
        const result = this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
        return (result.changes as number) > 0;
    }

    getSessionsByWorkspace(workspace: string): SessionRow[] {
        const rows = this.#db.prepare('SELECT * FROM sessions WHERE workspace = ? ORDER BY updated_at DESC').all(workspace) as Record<string, unknown>[];
        return rows.map(rowToSession);
    }

    getAllSessions(): SessionRow[] {
        const rows = this.#db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as Record<string, unknown>[];
        return rows.map(rowToSession);
    }

    // -----------------------------------------------------------------------
    // Message CRUD
    // -----------------------------------------------------------------------

    insertMessage(msg: Omit<MessageRow, 'id' | 'createdAt'> & Partial<Pick<MessageRow, 'id' | 'createdAt'>>): MessageRow {
        const id = msg.id ?? randomUUID();
        const createdAt = msg.createdAt ?? new Date().toISOString();
        this.#db.prepare(
            'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
        ).run(id, msg.sessionId, msg.role, msg.content, createdAt);
        return { id, sessionId: msg.sessionId, role: msg.role, content: msg.content, createdAt };
    }

    getMessagesBySessionId(sessionId: string): MessageRow[] {
        const rows = this.#db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as Record<string, unknown>[];
        return rows.map(rowToMessage);
    }

    getMessageCountBySessionId(sessionId: string): number {
        const row = this.#db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
        return row === undefined ? 0 : Number(row.count);
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    close(): void {
        this.#db.close();
    }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function defaultDbPath(): string {
    return join(homedir(), '.zeroagent', 'sessions.db');
}

function rowToSession(row: Record<string, unknown>): SessionRow {
    return {
        id: String(row.id),
        title: String(row.title ?? ''),
        model: String(row.model ?? ''),
        workspace: String(row.workspace ?? ''),
        parentSessionId: row.parent_session_id === null ? null : String(row.parent_session_id),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    };
}

function rowToMessage(row: Record<string, unknown>): MessageRow {
    return {
        id: String(row.id),
        sessionId: String(row.session_id),
        role: String(row.role),
        content: String(row.content),
        createdAt: String(row.created_at),
    };
}
