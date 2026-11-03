import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { ExtensionRunner } from './runner.ts';
import type { Extension } from './types.ts';

/** User-level extension directory: `~/.zeroagent/extensions`. */
export function userExtensionsDir(): string {
    return join(homedir(), '.zeroagent', 'extensions');
}

/** Project-level extension directory for a workspace. */
export function projectExtensionsDir(workdir: string): string {
    return join(workdir, '.zeroagent', 'extensions');
}

type ExtensionFile = {
    /** Identifier (filename without extension). */
    path: string;
    /** Absolute path of the module. */
    resolvedPath: string;
};

async function listExtensionFiles(dir: string): Promise<ExtensionFile[]> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
        .map((entry) => ({
            path: basename(entry.name, '.ts'),
            resolvedPath: join(dir, entry.name),
        }));
}

/**
 * Load every `.ts` extension from the user directory and then the project
 * directory, where a project extension with the same name overrides the
 * user-level one (matching skills, commands, and subagents).
 *
 * This reloads from scratch: previously loaded extensions are unloaded first.
 * A single broken extension is reported and skipped without affecting others.
 */
export async function loadExtensions(workdir: string, manager: ExtensionRunner): Promise<Extension[]> {
    const files = new Map<string, ExtensionFile>();
    for (const file of await listExtensionFiles(userExtensionsDir())) files.set(file.path, file);
    for (const file of await listExtensionFiles(projectExtensionsDir(workdir))) files.set(file.path, file);

    manager.unloadAll();

    const loaded: Extension[] = [];
    for (const file of files.values()) {
        try {
            loaded.push(await manager.loadExtensionFile(file.path, file.resolvedPath));
        } catch (error) {
            console.error(`[extensions] Failed to load "${file.path}": ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return loaded;
}
