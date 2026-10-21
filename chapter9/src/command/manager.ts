import type { CommandRegistry } from './registry.ts';

const BUILTIN_COMMANDS: readonly string[] = ['/sessions', '/resume', '/clear', '/reload'];

/**
 * Expand bash-style placeholders in a command template.
 *
 * Supported placeholders:
 * - `$N`            — the Nth positional argument (1-indexed). Missing
 *                     arguments become the empty string.
 * - `${N:-default}` — the Nth positional argument, or `default` when the
 *                     argument is missing or empty.
 *
 * Substitution runs in two passes: `${N:-default}` first, then `$N`. This
 * means a default value that references another argument (e.g. `${1:-$2}`)
 * resolves in the second pass, while a missing `$N` becomes an empty string.
 * Unsupported shell syntax (`$@`, `$*`, `$0`, `${1-default}`, ...) is left
 * as literal text.
 */
export function expandTemplate(template: string, args: readonly string[]): string {
    return template
        .replace(/\$\{(\d+):-([^}]*)\}/g, (_match: string, index: string, fallback: string) => {
            const value = args[Number(index) - 1];
            return value !== undefined && value !== '' ? value : fallback;
        })
        .replace(/\$(\d+)/g, (_match: string, index: string) => {
            return args[Number(index) - 1] ?? '';
        });
}

export function listAvailableCommands(registry: CommandRegistry): string {
    const userCommands = registry.names().map((name) => `/${name}`);
    return [...BUILTIN_COMMANDS, ...userCommands].join(', ');
}

/**
 * Dispatch a user slash command (`/name arg1 arg2`). Returns `true` when the
 * input is consumed as a command (registered or unknown), `false` otherwise.
 */
export async function tryRunCommand(
    registry: CommandRegistry,
    prompt: string,
    runPrompt: (prompt: string) => Promise<void>,
): Promise<boolean> {
    const tokens = prompt.split(/\s+/);
    const name = tokens[0]!.slice(1);
    const args = tokens.slice(1);

    const command = registry.get(name);
    if (command === undefined) {
        console.error(`\n[error] Unknown command: /${name}`);
        console.log(`Available commands: ${listAvailableCommands(registry)}\n`);
        return true;
    }

    const expanded = expandTemplate(command.template, args);
    await runPrompt(expanded);
    console.log();
    return true;
}