import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry } from './registry.ts';
import { EFFORT_LEVELS, type EffortLevel, type ModelDefinition, type ProviderAuth, type ThinkingLevelMap } from './types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(content: string, source: string): unknown {
    try {
        return JSON.parse(content);
    } catch (error) {
        throw new Error(`"${source}" has invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function requiredString(record: Record<string, unknown>, key: string, source: string): string {
    const value = record[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`"${source}" is missing a non-empty ${key} field`);
    }
    return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string, source: string): string | undefined {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`"${source}" has invalid ${key}: expected a non-empty string`);
    }
    return value.trim();
}

function optionalBoolean(record: Record<string, unknown>, key: string, source: string): boolean | undefined {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
        throw new Error(`"${source}" has invalid ${key}: expected a boolean`);
    }
    return value;
}

function optionalPositiveNumber(record: Record<string, unknown>, key: string, source: string): number | undefined {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`"${source}" has invalid ${key}: expected a positive number`);
    }
    return value;
}

function parseThinkingLevelMap(value: unknown, source: string): ThinkingLevelMap | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) throw new Error(`"${source}" has invalid thinkingLevelMap: expected a mapping`);

    const allowed = new Set<string>(EFFORT_LEVELS);
    const map: ThinkingLevelMap = {};
    for (const [level, mapped] of Object.entries(value)) {
        if (!allowed.has(level)) {
            throw new Error(`"${source}" has invalid thinkingLevelMap key "${level}": expected one of ${EFFORT_LEVELS.join(', ')}`);
        }
        if (mapped === null) {
            map[level as EffortLevel] = null;
        } else if (typeof mapped === 'string' && mapped.trim().length > 0) {
            map[level as EffortLevel] = mapped.trim();
        } else {
            throw new Error(`"${source}" has invalid thinkingLevelMap.${level}: expected a non-empty string or null`);
        }
    }
    return map;
}

export function parseAuthJson(content: string, source: string): Record<string, ProviderAuth> {
    const data = parseJson(content, source);
    if (!isRecord(data)) throw new Error(`"${source}" must be a JSON object mapping provider names to credentials`);

    const auth: Record<string, ProviderAuth> = {};
    for (const [provider, raw] of Object.entries(data)) {
        if (!isRecord(raw)) throw new Error(`"${source}" provider "${provider}" must be an object`);
        const providerSource = `${source} provider "${provider}"`;
        const baseUrl = requiredString(raw, 'baseUrl', providerSource);
        if (raw.type !== 'api_key') {
            throw new Error(`"${providerSource}" has unsupported type: expected "api_key"`);
        }
        const key = requiredString(raw, 'key', providerSource);
        auth[provider] = { baseUrl, type: 'api_key', key };
    }
    return auth;
}

export function parseModelsJson(content: string, source: string, providers: ReadonlySet<string>): ModelDefinition[] {
    const data = parseJson(content, source);
    if (!isRecord(data)) throw new Error(`"${source}" must be a JSON object mapping model ids to definitions`);

    const models: ModelDefinition[] = [];
    for (const [id, raw] of Object.entries(data)) {
        const modelSource = `${source} model "${id}"`;
        if (id.trim().length === 0) throw new Error(`"${source}" has an empty model id`);
        if (!isRecord(raw)) throw new Error(`"${modelSource}" must be an object`);

        const provider = requiredString(raw, 'provider', modelSource);
        if (!providers.has(provider)) {
            throw new Error(`"${modelSource}" references unknown provider "${provider}"`);
        }

        const definition: ModelDefinition = { id, provider };
        const name = optionalString(raw, 'name', modelSource);
        if (name !== undefined) definition.name = name;
        const reasoning = optionalBoolean(raw, 'reasoning', modelSource);
        if (reasoning !== undefined) definition.reasoning = reasoning;
        const maxTokens = optionalPositiveNumber(raw, 'maxTokens', modelSource);
        if (maxTokens !== undefined) definition.maxTokens = maxTokens;
        const thinkingLevelMap = parseThinkingLevelMap(raw.thinkingLevelMap, modelSource);
        if (thinkingLevelMap !== undefined) definition.thinkingLevelMap = thinkingLevelMap;

        models.push(definition);
    }
    return models;
}

export async function loadAuth(file: string): Promise<Record<string, ProviderAuth>> {
    let content: string;
    try {
        content = await readFile(file, 'utf-8');
    } catch {
        return {};
    }
    return parseAuthJson(content, file);
}

export async function loadModels(file: string, providers: ReadonlySet<string>): Promise<ModelDefinition[]> {
    let content: string;
    try {
        content = await readFile(file, 'utf-8');
    } catch {
        return [];
    }
    return parseModelsJson(content, file, providers);
}

export function authFilePath(): string {
    return join(homedir(), '.zeroagent', 'auth.json');
}

export function modelsConfigPath(): string {
    return join(homedir(), '.zeroagent', 'models-config.json');
}

export async function loadModelRegistry(authFile: string, modelsFile: string, target = new ModelRegistry()): Promise<ModelRegistry> {
    const auth = await loadAuth(authFile);
    for (const [provider, credentials] of Object.entries(auth)) {
        target.registerProvider(provider, credentials);
    }
    const models = await loadModels(modelsFile, new Set(Object.keys(auth)));
    for (const model of models) {
        target.registerModel(model);
    }
    return target;
}
