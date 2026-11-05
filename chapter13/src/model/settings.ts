import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { EFFORT_LEVELS, type EffortLevel } from './types.ts';

/**
 * User-level agent settings, persisted to `~/.zeroagent/settings.json`.
 *
 * Mirrors Pi's settings file: the "current" values are read at startup and
 * written back when the user switches them from the CLI.
 */
export type Settings = {
    /** Currently active model id (the value sent to the API as `model`). */
    currentModel?: string;
    /** Currently active reasoning effort level. */
    currentThinkingLevel?: EffortLevel;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse and validate the contents of a settings.json file.
 * Unknown keys are ignored so future settings can be added without breaking
 * older readers.
 */
export function parseSettingsJson(content: string, source: string): Settings {
    let data: unknown;
    try {
        data = JSON.parse(content);
    } catch (error) {
        throw new Error(`"${source}" has invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(data)) throw new Error(`"${source}" must be a JSON object`);

    const settings: Settings = {};

    const currentModel = data.currentModel;
    if (currentModel !== undefined) {
        if (typeof currentModel !== 'string' || currentModel.trim().length === 0) {
            throw new Error(`"${source}" has invalid currentModel: expected a non-empty string`);
        }
        settings.currentModel = currentModel.trim();
    }

    const currentThinkingLevel = data.currentThinkingLevel;
    if (currentThinkingLevel !== undefined) {
        if (typeof currentThinkingLevel !== 'string' || !(EFFORT_LEVELS as readonly string[]).includes(currentThinkingLevel)) {
            throw new Error(`"${source}" has invalid currentThinkingLevel: expected one of ${EFFORT_LEVELS.join(', ')}`);
        }
        settings.currentThinkingLevel = currentThinkingLevel as EffortLevel;
    }

    return settings;
}

/**
 * Load and mutate `~/.zeroagent/settings.json`.
 *
 * The store reads the file lazily, keeps the parsed settings in memory, and
 * writes the whole object back on each mutation so unrelated keys survive.
 */
export class SettingsStore {
    readonly #file: string;
    #settings: Settings | undefined;

    constructor(file?: string) {
        this.#file = file ?? defaultSettingsPath();
    }

    get file(): string {
        return this.#file;
    }

    /** Read the file (if present) and cache its parsed settings. */
    async load(): Promise<Settings> {
        let content: string;
        try {
            content = await readFile(this.#file, 'utf-8');
        } catch {
            this.#settings = {};
            return this.#settings;
        }
        this.#settings = parseSettingsJson(content, this.#file);
        return this.#settings;
    }

    /** The loaded settings, or `undefined` before `load()`. */
    snapshot(): Settings | undefined {
        return this.#settings;
    }

    /** Persist `currentModel` and remember it for later mutations. */
    async setCurrentModel(model: string): Promise<void> {
        await this.#ensureLoaded();
        this.#settings!.currentModel = model;
        await this.#persist();
    }

    /** Persist `currentThinkingLevel` and remember it for later mutations. */
    async setCurrentThinkingLevel(level: EffortLevel): Promise<void> {
        await this.#ensureLoaded();
        this.#settings!.currentThinkingLevel = level;
        await this.#persist();
    }

    async #ensureLoaded(): Promise<void> {
        if (this.#settings === undefined) await this.load();
    }

    async #persist(): Promise<void> {
        await mkdir(dirname(this.#file), { recursive: true });
        await writeFile(this.#file, `${JSON.stringify(this.#settings, null, 2)}\n`, 'utf-8');
    }
}

export function defaultSettingsPath(): string {
    return join(homedir(), '.zeroagent', 'settings.json');
}
