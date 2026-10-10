export type InputMessage = {
    role: 'user' | 'assistant' | 'developer' | 'system';
    content: string;
};

export type FunctionCallItem = {
    type: 'function_call';
    call_id: string;
    name: string;
    arguments: string;
};

export type FunctionCallOutputItem = {
    type: 'function_call_output';
    call_id: string;
    output: string;
};

export type InputItem = InputMessage | FunctionCallItem | FunctionCallOutputItem;

export type ResponseInput = string | readonly InputItem[];

export type FunctionTool = {
    type: 'function';
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict: boolean;
};

export type ReasoningConfig = {
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'max';
    summary?: 'auto' | 'concise' | 'detailed';
};

export type ResponsesRequest = {
    model: string;
    input: ResponseInput;
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
    | { type: typeof AgentEventType.Error; step?: number; message: string };

export type AgentOptions = {
    model?: string;
    maxSteps?: number;
    signal?: AbortSignal;
    reasoning?: ReasoningConfig;
};