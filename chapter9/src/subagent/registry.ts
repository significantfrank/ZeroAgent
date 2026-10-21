import type { SubAgentDefinition } from './types.ts';

export class AgentRegistry {
    readonly #agents = new Map<string, SubAgentDefinition>();

    register(definition: SubAgentDefinition): this {
        this.#agents.set(definition.name, definition);
        return this;
    }

    get(name: string): SubAgentDefinition | undefined {
        return this.#agents.get(name);
    }

    list(): SubAgentDefinition[] {
        return [...this.#agents.values()];
    }

    names(): string[] {
        return [...this.#agents.keys()];
    }

    clear(): void {
        this.#agents.clear();
    }
}