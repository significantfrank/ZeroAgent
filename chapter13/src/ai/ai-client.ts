import type { ProviderCredentials } from '../model/types.ts';

export type AiInputItem =
    | { role: 'user' | 'assistant' | 'developer' | 'system'; content: string }
    | { type: 'tool_call'; toolCall: ToolCall }
    | { type: 'tool_result'; toolCallId: string; content: string };

export type AiTool = {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
};

export type AiRequest = {
    model: string;
    input: string | readonly AiInputItem[];
    instructions?: string;
    tools?: readonly AiTool[];
    parallelToolCalls?: boolean;
    reasoning?: { effort?: string; summary?: 'auto' | 'concise' | 'detailed' };
    store?: boolean;
    maxOutputTokens?: number;
    signal?: AbortSignal;
};

export type ToolCall = {
    id: string;
    name: string;
    arguments: string;
};

export type AiEvent =
    | { type: 'start' }
    | { type: 'text_start' }
    | { type: 'text_delta'; delta: string }
    | { type: 'text_end'; content: string }
    | { type: 'thinking_start' }
    | { type: 'thinking_delta'; delta: string }
    | { type: 'thinking_end'; content: string }
    | { type: 'toolcall_start' }
    | { type: 'toolcall_delta'; delta: string }
    | { type: 'toolcall_end'; toolCall: ToolCall }
    | { type: 'done'; reason: string }
    | { type: 'error'; reason: string };

export interface AiClient {
    stream(request: AiRequest): AsyncGenerator<AiEvent>;
}

export type ProviderResolver = (modelId: string) => ProviderCredentials | undefined;
