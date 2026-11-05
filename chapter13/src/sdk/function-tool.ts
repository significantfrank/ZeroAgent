import type { ToolDefinition, ToolHandlerContext } from '../tool/types.ts';

export type JsonSchema = Record<string, unknown>;

export type FunctionToolOptions = {
    name: string;
    description: string;
    parameters: JsonSchema;
    execute: (input: Record<string, unknown>, context: ToolHandlerContext) => unknown | Promise<unknown>;
};

export interface FunctionToolLike {
    readonly name: string;
    readonly description: string;
    readonly definition: ToolDefinition;
    execute(args: Record<string, unknown>, context?: ToolHandlerContext): Promise<string>;
}

export class FunctionTool implements FunctionToolLike {
    readonly name: string;
    readonly description: string;
    readonly #execute: FunctionToolOptions['execute'];
    readonly definition: ToolDefinition;

    constructor(options: FunctionToolOptions) {
        this.name = options.name;
        this.description = options.description;
        this.#execute = options.execute;

        if (typeof options.parameters !== 'object' || options.parameters === null || Array.isArray(options.parameters)) {
            throw new Error(`Tool "${options.name}" parameters must be a JSON Schema object.`);
        }
        const parameterSchema = this.#toJsonSchema(options.parameters);
        this.definition = {
            type: 'function',
            name: options.name,
            description: options.description,
            parameters: parameterSchema,
            strict: false,
        };
    }

    #toJsonSchema(parameters: JsonSchema): Record<string, unknown> {
        const entries = Object.entries(parameters);
        const isDescriptionMap = !('type' in parameters) &&
            !('properties' in parameters) &&
            entries.every(([, value]) => typeof value === 'string');
        if (!isDescriptionMap) return { ...parameters };

        return {
            type: 'object',
            properties: Object.fromEntries(
                entries.map(([name, description]) => [name, { type: 'string', description }]),
            ),
            required: entries.map(([name]) => name),
        };
    }

    async execute(args: Record<string, unknown>, context: ToolHandlerContext = {}): Promise<string> {
        const result = await this.#execute(args, context);
        if (typeof result === 'string') return result;

        const serialized = JSON.stringify(result);
        if (serialized === undefined) {
            throw new Error(`Tool "${this.name}" returned a value that cannot be serialized.`);
        }
        return serialized;
    }
}
