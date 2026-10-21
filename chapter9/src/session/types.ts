/**
 * A row in the `sessions` table.
 */
export type SessionRow = {
    id: string;
    title: string;
    model: string;
    workspace: string;
    parentSessionId: string | null;
    createdAt: string;
    updatedAt: string;
};

/**
 * A row in the `messages` table.
 */
export type MessageRow = {
    id: string;
    sessionId: string;
    role: string;
    content: string;
    createdAt: string;
};

/**
 * Session metadata with message count — used by list/get operations.
 */
export type SessionMeta = SessionRow & {
    messageCount: number;
};
