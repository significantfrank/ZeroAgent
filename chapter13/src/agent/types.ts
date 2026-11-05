import type { ModelRegistry } from '../model/registry.ts';
import type { EffortLevel } from '../model/types.ts';
import type { SessionManager } from '../session/manager.ts';
import type { AiInputItem, AiEvent, ToolCall } from '../ai/ai-client.ts';
import type { ExtensionRunner } from '../extension/runner.ts';

export type { FunctionCallItem, FunctionCallOutputItem, ToolDefinition as FunctionTool } from '../tool/types.ts';
export type { AiEvent as AssistantMessageEvent, ToolCall } from '../ai/ai-client.ts';

export type InputMessage = Extract<AiInputItem, { role: string }>;
export type InputItem = AiInputItem;

export type ReasoningConfig = {
    /** Canonical effort level requested by the caller. */
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'max';
    summary?: 'auto' | 'concise' | 'detailed';
};

export type ToolResultMessage = {
    role: 'toolResult';
    toolCallId: string;
    toolName: string;
    content: string;
    isError: boolean;
    durationMs?: number;
};

export type SystemMessage = {
    role: 'system';
    content: string;
};

export type UserMessage = {
    role: 'user';
    content: string;
};

export type AssistantMessage = {
    role: 'assistant';
    content: string;
    thinking?: string;
    toolCalls?: ToolCall[];
};

export type AgentMessage =
    | SystemMessage
    | UserMessage
    | AssistantMessage
    | ToolResultMessage;

export type AgentEvent =
    | { type: 'agent_start' }
    | { type: 'agent_end'; message: AgentMessage; }
    | { type: 'turn_start' }
    | { type: 'turn_end'; message: AgentMessage; toolResults: ToolResultMessage[] }
    | { type: 'error'; reason: string }
    | { type: 'message_start' }
    | { type: 'message_update'; message?: AssistantMessage; aiEvent: AiEvent }
    | { type: 'message_end'; message?: AssistantMessage }
    | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: any }
    | { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: any; partialResult: any }
    | {
        type: 'tool_execution_end';
        toolCallId: string;
        toolName: string;
        result: any;
        isError: boolean;
        /** Milliseconds `execute()` took, measured with a monotonic clock; absent when the tool did not run. */
        durationMs?: number;
    };

export type AgentOptions = {
    model?: string;
    instruction?: string;
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
    /** Optional extension runner for lifecycle hooks and command/tool registrations. */
    extensions?: ExtensionRunner;
};
