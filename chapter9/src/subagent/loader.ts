import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AgentRegistry } from './registry.ts';
import type { SubAgentDefinition, LoadedSubAgent } from './types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(metadata: Record<string, unknown>, key: string, source: string): string {
    const value = metadata[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`Agent file "${source}" is missing a non-empty ${key} field`);
    }
    return value.trim();
}

function parseTools(value: unknown, source: string): Record<string, boolean> | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) throw new Error(`Agent file "${source}" has invalid tools: expected a mapping`);
    for (const [toolName, enabled] of Object.entries(value)) {
        if (typeof enabled !== 'boolean') {
            throw new Error(`Agent file "${source}" has invalid tools.${toolName}: expected boolean`);
        }
    }
    return value as Record<string, boolean>;
}

export function parseAgentFile(content: string, source: string): SubAgentDefinition {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (match === null) {
        throw new Error(`Agent file "${source}" is missing YAML frontmatter`);
    }

    let metadata: unknown;
    try {
        metadata = parseYaml(match[1]!);
    } catch (error) {
        throw new Error(`Agent file "${source}" has invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(metadata)) throw new Error(`Agent file "${source}" frontmatter must be a mapping`);

    const allowedKeys = new Set(['name', 'description', 'mode', 'model', 'tools']);
    for (const key of Object.keys(metadata)) {
        if (!allowedKeys.has(key)) throw new Error(`Agent file "${source}" has unknown frontmatter field "${key}"`);
    }

    const name = requiredString(metadata, 'name', source);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        throw new Error(`Agent file "${source}" has invalid name "${name}": expected kebab-case`);
    }
    const description = requiredString(metadata, 'description', source);
    if (metadata.mode !== 'subagent') {
        throw new Error(`Agent file "${source}" must set mode: subagent`);
    }

    let model: string | undefined;
    if (metadata.model !== undefined && metadata.model !== null && metadata.model !== '') {
        if (typeof metadata.model !== 'string' || metadata.model.trim().length === 0) {
            throw new Error(`Agent file "${source}" has invalid model: expected a non-empty string`);
        }
        model = metadata.model.trim();
    }

    const tools = parseTools(metadata.tools, source);
    const systemPrompt = match[2]!.trim();
    if (systemPrompt.length === 0) throw new Error(`Agent file "${source}" has an empty system prompt`);

    return {
        name,
        description,
        mode: 'subagent',
        ...(model === undefined ? {} : { model }),
        ...(tools === undefined ? {} : { tools }),
        systemPrompt,
    };
}

export async function loadAgentFromFile(file: string): Promise<LoadedSubAgent | undefined> {
    let content: string;
    try {
        content = await readFile(file, 'utf-8');
    } catch {
        return undefined;
    }
    return { definition: parseAgentFile(content, file), source: file };
}

export async function loadAgentsFromDirectory(dir: string): Promise<LoadedSubAgent[]> {
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch {
        return [];
    }

    const loaded: LoadedSubAgent[] = [];
    for (const entry of entries.sort()) {
        if (!entry.endsWith('.md')) continue;
        const result = await loadAgentFromFile(join(dir, entry));
        if (result !== undefined) loaded.push(result);
    }
    return loaded;
}

export function userAgentsDir(): string {
    return join(homedir(), '.zeroagent', 'agents');
}

export function projectAgentsDir(workdir: string): string {
    return join(workdir, '.zeroagent', 'agents');
}


export async function loadAllAgents(workdir: string, userDirectory = userAgentsDir()): Promise<{
    registry: AgentRegistry;
    loaded: LoadedSubAgent[];
}> {
    const registry = new AgentRegistry();
    const loaded: LoadedSubAgent[] = [];
    for (const dir of [userDirectory, projectAgentsDir(workdir)]) {
        for (const entry of await loadAgentsFromDirectory(dir)) {
            registry.register(entry.definition);
            loaded.push(entry);
        }
    }
    return { registry, loaded };
}

export async function loadAgents(workdir: string, target: AgentRegistry): Promise<LoadedSubAgent[]> {
    const { registry, loaded } = await loadAllAgents(workdir);
    target.clear();
    for (const definition of registry.list()) target.register(definition);
    return loaded;
}