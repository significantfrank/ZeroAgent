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

export type AgentEvent =
    | { type: 'step_start'; step: number }
    | { type: 'reasoning_delta'; step: number; delta: string }
    | { type: 'content_delta'; step: number; delta: string }
    | { type: 'tool_call'; step: number; call: FunctionCallItem }
    | { type: 'tool_result'; step: number; callId: string; name: string; output: string; error?: string }
    | { type: 'step_end'; step: number; toolCalls: number }
    | { type: 'run_end'; steps: number; text: string }
    | { type: 'error'; step?: number; message: string };

export type AgentOptions = {
    model?: string;
    maxSteps?: number;
    signal?: AbortSignal;
    reasoning?: ReasoningConfig;
};