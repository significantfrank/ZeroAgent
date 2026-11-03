import { EFFORT_LEVELS, type EffortLevel, type ModelDefinition, type ProviderAuth, type ProviderCredentials } from './types.ts';

export class ModelRegistry {
    readonly #models = new Map<string, ModelDefinition>();
    readonly #providers = new Map<string, ProviderAuth>();

    registerModel(definition: ModelDefinition): this {
        this.#models.set(definition.id, definition);
        return this;
    }

    registerProvider(name: string, auth: ProviderAuth): this {
        this.#providers.set(name, auth);
        return this;
    }

    get(id: string): ModelDefinition | undefined {
        return this.#models.get(id);
    }

    list(): ModelDefinition[] {
        return [...this.#models.values()];
    }

    names(): string[] {
        return [...this.#models.keys()];
    }

    resolveAuth(id: string): ProviderCredentials | undefined {
        const model = this.#models.get(id);
        if (model === undefined) return undefined;
        const auth = this.#providers.get(model.provider);
        if (auth === undefined) return undefined;
        return { baseUrl: auth.baseUrl, key: auth.key };
    }

    availableEfforts(id: string): EffortLevel[] | undefined {
        const map = this.#models.get(id)?.thinkingLevelMap;
        if (map === undefined) return undefined;
        return EFFORT_LEVELS.filter((level) => map[level] !== null && map[level] !== undefined);
    }

    clear(): void {
        this.#models.clear();
        this.#providers.clear();
    }
}
