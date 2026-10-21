import type { CommandDefinition } from './types.ts';

/**
 * Registry for user-defined commands available to the CLI.
 *
 * Commands are registered by name (invoked as `/name`). Later registrations
 * with the same name overwrite earlier ones, which lets project-level
 * commands override user-level commands with the same name.
 */
export class CommandRegistry {
    readonly #commands = new Map<string, CommandDefinition>();

    /**
     * Register a command. If a command with the same name already exists it is
     * replaced.
     */
    register(command: CommandDefinition): void {
        this.#commands.set(command.name, command);
    }

    /**
     * Get a command by name, or `undefined` if not registered.
     */
    get(name: string): CommandDefinition | undefined {
        return this.#commands.get(name);
    }

    /**
     * List all registered commands in registration order.
     */
    list(): readonly CommandDefinition[] {
        return [...this.#commands.values()];
    }

    /**
     * List the names of all registered commands.
     */
    names(): readonly string[] {
        return [...this.#commands.keys()];
    }

    /**
     * Check whether a command with the given name is registered.
     */
    has(name: string): boolean {
        return this.#commands.has(name);
    }

    /**
     * Remove a command from the registry.
     */
    remove(name: string): boolean {
        return this.#commands.delete(name);
    }

    /**
     * Remove all registered commands.
     */
    clear(): void {
        this.#commands.clear();
    }
}
