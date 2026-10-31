import type { AgentEvent, AgentMessage } from '../agent/types.ts';
import type { SystemPromptOptions } from '../agent/system-prompt.ts';
import type { ToolDefinition, ToolHandler } from '../tool/types.ts';

/**
 * A message an extension may inject into a request.
 *
 * `toolResult` messages are excluded: they only make sense as the reply to a
 * matching tool call, which extensions cannot synthesize safely.
 */
export type InjectableMessage = Extract<AgentMessage, { role: 'system' | 'user' | 'assistant' }>;

/**
 * Fired once per run, before the request is assembled and before any other
 * event. Handlers mutate `systemPromptOptions` to shape the system prompt and
 * may return `messages` to inject extra request items.
 */
export type BeforeAgentStartEvent = {
    type: 'before_agent_start';
    /** The user input that started this run. */
    input: string;
    /** Initial snapshot of the rendered system prompt (read-only convenience). */
    systemPrompt: string;
    /** Mutable prompt options; changes apply to this run's system prompt. */
    systemPromptOptions: SystemPromptOptions;
};

/**
 * A lifecycle event extensions can observe.
 *
 * It is a strict superset of the raw `AgentEvent` stream: `before_agent_start`
 * is added on top, while every event yielded by `Agent.stream()` also reaches
 * extensions unchanged.
 */
export type ExtensionEvent = BeforeAgentStartEvent | AgentEvent;

export type ExtensionEventType = ExtensionEvent['type'];

/** Mutations a handler may return to influence the run. */
export type ExtensionResult = {
    /** Messages injected into the request before the user turn. */
    messages?: InjectableMessage[];
};

/** Context shared by every handler invocation. */
export type ExtensionContext = {
    /** The user input that started this run. */
    input: string;
};

export type ExtensionHandler<E extends ExtensionEvent = ExtensionEvent> = (
    event: E,
    context: ExtensionContext,
) => void | ExtensionResult | Promise<void | ExtensionResult>;

/** Alias used by the `Extension` registry bookkeeping. */
export type HandlerFn = ExtensionHandler;

/** Context handed to a registered command handler. */
export type CommandContext = {
    /** The raw command line, e.g. `/hello world`. */
    input: string;
};

/** A tool registered by an extension. */
export interface RegisteredTool {
    name: string;
    definition: ToolDefinition;
    handler: ToolHandler;
}

/** A command registered by an extension. */
export interface RegisteredCommand {
    name: string;
    description: string;
    handler: (args: string, ctx: CommandContext) => void | Promise<void>;
}

/** A loaded extension and the handlers/tools/commands it registered. */
export interface Extension {
    /** Stable identifier (filename without extension). */
    path: string;
    /** Absolute path of the extension module. */
    resolvedPath: string;
    /** Handlers registered via `ExtensionAPI.on`, grouped by event type. */
    handlers: Map<ExtensionEventType, HandlerFn[]>;
    /** Tools registered via `ExtensionAPI.registerTool`. */
    tools?: Map<string, RegisteredTool>;
    /** Commands registered via `ExtensionAPI.registerCommand`. */
    commands?: Map<string, RegisteredCommand>;
}

/** API handed to an extension's default export. */
export interface ExtensionAPI {
    on<K extends ExtensionEventType>(
        type: K,
        handler: ExtensionHandler<Extract<ExtensionEvent, { type: K }>>,
    ): void;
    registerCommand(name: string, command: Omit<RegisteredCommand, 'name'>): void;
    registerTool(definition: ToolDefinition, handler: ToolHandler): void;
}
