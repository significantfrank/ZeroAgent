import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CommandDefinition, LoadedCommand } from './types.ts';
import { CommandRegistry } from './registry.ts';
import { splitFrontmatter } from '../util/frontmatter.ts';

/**
 * Parse a command Markdown file.
 *
 * The file format is:
 * ```
 * ---
 * name: my-command
 * description: A short description
 * ---
 * Prompt template body with $1, ${2:-default} placeholders...
 * ```
 *
 * The frontmatter is delimited by `---` lines and contains `name` and
 * `description` fields. The body after the frontmatter becomes the command's
 * `template`.
 */
export function parseCommandFile(content: string, source: string): CommandDefinition {
    const { frontmatter, body } = splitFrontmatter(content, source);
    if (frontmatter.name === undefined) {
        throw new Error(`Command file "${source}" is missing required frontmatter field: name`);
    }
    if (frontmatter.description === undefined) {
        throw new Error(`Command file "${source}" is missing required frontmatter field: description`);
    }
    const template = body.trim();
    if (template.length === 0) {
        throw new Error(`Command file "${source}" has empty template body`);
    }
    return {
        name: frontmatter.name,
        description: frontmatter.description,
        template,
    };
}

/**
 * Load a single command from a `.md` file.
 *
 * Returns `undefined` if the file cannot be read. Parse errors (missing or
 * malformed frontmatter, empty template body) are thrown so they surface
 * during loading.
 */
export async function loadCommandFromFile(file: string): Promise<LoadedCommand | undefined> {
    let content: string;
    try {
        content = await readFile(file, 'utf-8');
    } catch {
        return undefined;
    }
    const command = parseCommandFile(content, file);
    return { command, source: file };
}

/**
 * Load all commands from a directory.
 *
 * Every `*.md` file in the directory is loaded as a command. Non-`.md` files
 * and subdirectories are skipped.
 *
 * Returns an empty array if the directory does not exist or contains no
 * command files.
 */
export async function loadCommandsFromDirectory(dir: string): Promise<LoadedCommand[]> {
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch {
        // Directory does not exist — not an error, just no commands.
        return [];
    }

    const loaded: LoadedCommand[] = [];

    for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const result = await loadCommandFromFile(join(dir, entry));
        if (result !== undefined) {
            loaded.push(result);
        }
    }

    return loaded;
}

/**
 * Default user-level commands directory: `~/.zeroagent/commands/`.
 */
export function userCommandsDir(): string {
    return join(homedir(), '.zeroagent', 'commands');
}

/**
 * Project-level commands directory: `{workdir}/.zeroagent/commands/`.
 */
export function projectCommandsDir(workdir: string): string {
    return join(workdir, '.zeroagent', 'commands');
}

/**
 * Load commands from both user-level and project-level directories.
 *
 * Commands are loaded in order: user-level first, then project-level.
 * Project-level commands with the same name as a user-level command will
 * overwrite the earlier registration (last-write-wins).
 *
 * Returns the populated CommandRegistry and the list of loaded commands with
 * their source paths.
 */
export async function loadAllCommands(workdir: string): Promise<{
    registry: CommandRegistry;
    loaded: LoadedCommand[];
}> {
    const registry = new CommandRegistry();
    const loaded: LoadedCommand[] = [];

    const dirs = [userCommandsDir(), projectCommandsDir(workdir)];

    for (const dir of dirs) {
        const commands = await loadCommandsFromDirectory(dir);
        for (const entry of commands) {
            registry.register(entry.command);
            loaded.push(entry);
        }
    }

    return { registry, loaded };
}

/**
 * Load commands from disk and replace the contents of the provided registry.
 */
export async function loadCommands(workdir: string, target: CommandRegistry): Promise<LoadedCommand[]> {
    const { registry, loaded } = await loadAllCommands(workdir);
    target.clear();
    for (const command of registry.list()) {
        target.register(command);
    }
    return loaded;
}
