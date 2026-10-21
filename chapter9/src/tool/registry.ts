import type { FunctionCallItem, ToolDefinition, ToolHandler, ToolResult } from './types.ts';
import type { SubAgentDefinition } from '../subagent/types.ts';

export function parseToolArguments(call: FunctionCallItem): Record<string, unknown> {
    const args: unknown = JSON.parse(call.arguments);
    if (typeof args !== 'object' || args === null) {
        throw new Error('Tool arguments must be a JSON object');
    }
    return args as Record<string, unknown>;
}

export class ToolRegistry {
    readonly #entries = new Map<string, { definition: ToolDefinition; handler: ToolHandler }>();

    register(definition: ToolDefinition, handler: ToolHandler): this {
        this.#entries.set(definition.name, { definition, handler });
        return this;
    }

    copyFrom(source: ToolRegistry, agentDefinition?: SubAgentDefinition): this {
        for (const [name, entry] of source.#entries) {
            if (agentDefinition === undefined || agentDefinition.tools?.[name] === true) {
                this.register(entry.definition, entry.handler);
            }
        }
        return this;
    }

    definitions(): ToolDefinition[] {
        return [...this.#entries.values()].map((entry) => entry.definition);
    }

    async execute(call: FunctionCallItem): Promise<ToolResult | undefined> {
        const entry = this.#entries.get(call.name);
        if (entry === undefined) return undefined;

        try {
            const result = await entry.handler(call, parseToolArguments(call));
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
