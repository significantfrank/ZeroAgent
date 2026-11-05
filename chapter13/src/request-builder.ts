import type { ToolDefinition } from './tool/types.ts';
import type { AiInputItem, AiRequest } from './ai/ai-client.ts';

export class PromptRequestBuilder {
    readonly #model: string;
    readonly #input: AiInputItem[] = [];
    readonly #tools = new Map<string, ToolDefinition>();
    #instructions: string | undefined;
    #parallelToolCalls: boolean | undefined;
    #store: boolean | undefined;
    #reasoning: AiRequest['reasoning'];
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

    addInputItem(item: AiInputItem): this {
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

    setReasoning(reasoning: NonNullable<AiRequest['reasoning']>): this {
        this.#reasoning = reasoning;
        return this;
    }

    setMaxOutputTokens(tokens: number): this {
        this.#maxOutputTokens = tokens;
        return this;
    }

    build(): AiRequest {
        return {
            model: this.#model,
            input: [...this.#input],
            instructions: this.#instructions,
            tools: [...this.#tools.values()],
            parallelToolCalls: this.#parallelToolCalls,
            store: this.#store,
            reasoning: this.#reasoning,
            maxOutputTokens: this.#maxOutputTokens,
        };
    }
}