import type { FunctionCallItem, ToolHandler, ToolResult } from './types.ts';
import type { SubAgentDefinition } from '../subagent/types.ts';

export function parseToolArguments(call: FunctionCallItem): Record<string, unknown> {
    const args: unknown = JSON.parse(call.arguments);
    if (typeof args !== 'object' || args === null) {
        throw new Error('Tool arguments must be a JSON object');
    }
    return args as Record<string, unknown>;
}

export class ToolRegistry {
    readonly #handlers = new Map<string, ToolHandler>();

    register(name: string, handler: ToolHandler): this {
        this.#handlers.set(name, handler);
        return this;
    }

    copyFrom(source: ToolRegistry, agentDefinition: SubAgentDefinition): this {
        for (const [name, handler] of source.#handlers) {
            if (agentDefinition.tools?.[name] === true) this.register(name, handler);
        }
        return this;
    }

    async execute(call: FunctionCallItem): Promise<ToolResult | undefined> {
        const handler = this.#handlers.get(call.name);
        if (handler === undefined) return undefined;

        try {
            const result = await handler(call, parseToolArguments(call));
            return typeof result === 'string'
                ? { callId: call.call_id, name: call.name, output: result }
                : result;
        } catch (error) {
            return {
                callId: call.call_id,
                name: call.name,
                output: error instanceof Error ? error.message : String(error),
                error: 'tool_error',
            };
        }
    }
}
