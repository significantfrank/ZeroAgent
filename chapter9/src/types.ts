import type { SessionManager } from './session/manager.ts';
import type { FunctionCallItem, FunctionCallOutputItem, FunctionTool } from './tool/types.ts';

export type { FunctionCallItem, FunctionCallOutputItem, FunctionTool } from './tool/types.ts';

export type InputMessage = {
    role: 'user' | 'assistant' | 'developer' | 'system';
    content: string;
};

export type InputItem = InputMessage | FunctionCallItem | FunctionCallOutputItem;

export type ResponseInput = string | readonly InputItem[];

export type ReasoningConfig = {
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'max';
    summary?: 'auto' | 'concise' | 'detailed';
};

export type ResponsesRequest = {
    model: string;
    input: ResponseInput;
    instructions?: string;
    tools?: readonly FunctionTool[];
    parallel_tool_calls?: boolean;
    reasoning?: ReasoningConfig;
    stream?: boolean;
    store?: boolean;
};

export const AgentEventType = {
    StepStart: 'step_start',
    ReasoningDelta: 'reasoning_delta',
    ContentDelta: 'content_delta',
    TokenUsage: 'token_usage',
    ToolCall: 'tool_call',
    ToolResult: 'tool_result',
    StepEnd: 'step_end',
    RunEnd: 'run_end',
    Error: 'error',
    SubagentStart: 'subagent_start',
    SubagentEnd: 'subagent_end',
} as const;

export type AgentEventType = typeof AgentEventType[keyof typeof AgentEventType];

export type AgentEvent =
    | { type: typeof AgentEventType.StepStart; step: number }
    | { type: typeof AgentEventType.ReasoningDelta; step: number; delta: string }
    | { type: typeof AgentEventType.ContentDelta; step: number; delta: string }
    | { type: typeof AgentEventType.TokenUsage; step: number; inputTokens: number; outputTokens: number; totalTokens: number; cachedTokens?: number; reasoningTokens?: number }
    | { type: typeof AgentEventType.ToolCall; step: number; call: FunctionCallItem }
    | { type: typeof AgentEventType.ToolResult; step: number; callId: string; name: string; output: string; error?: string }
    | { type: typeof AgentEventType.StepEnd; step: number; toolCalls: number }
    | { type: typeof AgentEventType.RunEnd; steps: number; text: string }
    | { type: typeof AgentEventType.Error; step?: number; message: string }
    | { type: typeof AgentEventType.SubagentStart; name: string }
    | { type: typeof AgentEventType.SubagentEnd; name: string };

export type AgentOptions = {
    model?: string;
    maxSteps?: number;
    signal?: AbortSignal;
    reasoning?: ReasoningConfig;
    /** Working directory for file operations and skill discovery. Defaults to process.cwd(). */
    workdir?: string;
    /** Optional session manager for conversation persistence. */
    sessionManager?: SessionManager;
    /** Active session ID when a sessionManager is provided. */
    sessionId?: string;
};
