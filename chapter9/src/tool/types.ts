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

export type FunctionTool = {
    type: 'function';
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict: boolean;
};

export type ToolResult = {
    callId: string;
    name: string;
    output: string;
    error?: string;
};

export type ToolHandler = (
    call: FunctionCallItem,
    args: Record<string, unknown>,
) => string | ToolResult | Promise<string | ToolResult>;