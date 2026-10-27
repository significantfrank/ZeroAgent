import type { ModelRegistry } from './model/registry.ts';
import type { EffortLevel } from './model/types.ts';
import type { SessionManager } from './session/manager.ts';
import type { FunctionCallItem, FunctionCallOutputItem, ToolDefinition } from './tool/types.ts';

export type { FunctionCallItem, FunctionCallOutputItem, ToolDefinition as FunctionTool } from './tool/types.ts';

export type InputMessage = {
    role: 'user' | 'assistant' | 'developer' | 'system';
    content: string;
};

export type InputItem = InputMessage | FunctionCallItem | FunctionCallOutputItem;

export type ResponseInput = string | readonly InputItem[];

export type ReasoningConfig = {
    /** Canonical effort level requested by the caller. */
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'max';
    summary?: 'auto' | 'concise' | 'detailed';
};

/** Wire-level reasoning sent to the API; `effort` may be a provider-specific value. */
export type RequestReasoning = {
    effort?: string;
    summary?: 'auto' | 'concise' | 'detailed';
};

export type ResponsesRequest = {
    model: string;
    input: ResponseInput;
    instructions?: string;
    tools?: readonly ToolDefinition[];
    parallel_tool_calls?: boolean;
    reasoning?: RequestReasoning;
    stream?: boolean;
    store?: boolean;
    max_output_tokens?: number;
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
    /** Active thinking level used when `reasoning.effort` is not supplied. Defaults to `high`. */
    thinkingLevel?: EffortLevel;
    /** Working directory for file operations and skill discovery. Defaults to process.cwd(). */
    workdir?: string;
    /** Optional session manager for conversation persistence. */
    sessionManager?: SessionManager;
    /** Active session ID when a sessionManager is provided. */
    sessionId?: string;
    /** Optional model registry for model-driven reasoning and provider routing. */
    modelRegistry?: ModelRegistry;
};
