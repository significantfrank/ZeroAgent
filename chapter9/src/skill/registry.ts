import type { SkillDefinition } from './types.ts';
import type { ToolDefinition } from '../tool/types.ts';

/**
 * Registry for skills available to the agent.
 *
 * Skills are registered by name (kebab-case). Later registrations with the
 * same name overwrite earlier ones, which lets project-level skills override
 * user-level skills with the same name.
 */
export class SkillRegistry {
    readonly #skills = new Map<string, SkillDefinition>();

    /**
     * Register a skill. If a skill with the same name already exists it is
     * replaced.
     */
    register(skill: SkillDefinition): void {
        this.#skills.set(skill.name, skill);
    }

    copyFrom(source: SkillRegistry): this {
        for (const skill of source.#skills.values()) {
            this.register(skill);
        }
        return this;
    }

    /**
     * Get a skill by name, or `undefined` if not registered.
     */
    get(name: string): SkillDefinition | undefined {
        return this.#skills.get(name);
    }

    /**
     * List all registered skills in insertion order.
     */
    list(): readonly SkillDefinition[] {
        return [...this.#skills.values()];
    }

    /**
     * List the names of all registered skills.
     */
    names(): readonly string[] {
        return [...this.#skills.keys()];
    }

    /**
     * Check whether a skill with the given name is registered.
     */
    has(name: string): boolean {
        return this.#skills.has(name);
    }

    /**
     * Remove a skill from the registry.
     */
    remove(name: string): boolean {
        return this.#skills.delete(name);
    }

    /**
     * Remove all registered skills.
     */
    clear(): void {
        this.#skills.clear();
    }

    /**
     * Build a combined instructions string from all registered skills.
     * Each skill's instructions are prefixed with a header showing the skill name.
     * Returns an empty string if no skills are registered.
     */
    buildInstructions(): string {
        const skills = this.list();
        if (skills.length === 0) return '';
        return skills
            .map((skill) => `## Skill: ${skill.name}\n\n${skill.instructions}`)
            .join('\n\n---\n\n');
    }

    /**
     * Build a compact catalog that lets the agent choose a skill to load.
     */
    buildCatalog(): string {
        const skills = this.list();
        if (skills.length === 0) return '';
        return skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n');
    }

    /** Build the skill name and description list for the prompt. */
    buildPromptInstructions(): string {
        const catalog = this.buildCatalog();
        return catalog.length > 0 ? `可用的skills:\n${catalog}` : '';
    }

    /**
     * Collect all tools from all registered skills.
     * Returns an empty array if no skills have tools.
     */
    collectTools(): readonly ToolDefinition[] {
        const tools: ToolDefinition[] = [];
        for (const skill of this.list()) {
            if (skill.tools !== undefined) {
                tools.push(...skill.tools);
            }
        }
        return tools;
    }
}
