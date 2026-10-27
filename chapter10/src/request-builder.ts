import type { ToolDefinition } from './tool/types.ts';
import type { InputItem, RequestReasoning, ResponsesRequest } from './types.ts';

export class PromptRequestBuilder {
    readonly #model: string;
    readonly #input: InputItem[] = [];
    readonly #tools = new Map<string, ToolDefinition>();
    #instructions: string | undefined;
    #parallelToolCalls: boolean | undefined;
    #store: boolean | undefined;
    #reasoning: RequestReasoning | undefined;
    #maxOutputTokens: number | undefined;

    constructor(model: string) {
        this.#model = model;
    }

    addDeveloperMsg(content: string): this {
        this.#input.push({ role: 'developer', content });
        return this;
    }

    addUserMsg(content: string): this {
        this.#input.push({ role: 'user', content });
        return this;
    }

    addInputItem(item: InputItem): this {
        this.#input.push(item);
        return this;
    }

    setInstructions(instructions: string): this {
        this.#instructions = instructions;
        return this;
    }

    addTool(tool: ToolDefinition): this {
        this.#tools.set(tool.name, tool);
        return this;
    }

    setParallelToolCalls(enabled: boolean): this {
        this.#parallelToolCalls = enabled;
        return this;
    }

    setStore(enabled: boolean): this {
        this.#store = enabled;
        return this;
    }

    setReasoning(reasoning: RequestReasoning): this {
        this.#reasoning = reasoning;
        return this;
    }

    setMaxOutputTokens(tokens: number): this {
        this.#maxOutputTokens = tokens;
        return this;
    }

    build(): ResponsesRequest {
        return {
            model: this.#model,
            input: [...this.#input],
            instructions: this.#instructions,
            tools: [...this.#tools.values()],
            parallel_tool_calls: this.#parallelToolCalls,
            store: this.#store,
            reasoning: this.#reasoning,
            max_output_tokens: this.#maxOutputTokens,
        };
    }
}