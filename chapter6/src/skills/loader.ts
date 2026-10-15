import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { LoadedSkill, SkillDefinition, SkillFrontmatter } from './types.ts';
import { SkillRegistry } from './registry.ts';

/** The main skill file inside each skill directory. */
const SKILL_FILE = 'skill.md';

/**
 * Parse a skill Markdown file.
 *
 * The file format is:
 * ```
 * ---
 * name: my-skill
 * description: A short description
 * ---
 * Instructions text in Markdown...
 * ```
 *
 * The frontmatter is delimited by `---` lines and contains `name` and
 * `description` fields. The body after the frontmatter becomes the skill's
 * `instructions`.
 */
export function parseSkillFile(content: string, source: string): SkillDefinition {
    const { frontmatter, body } = splitFrontmatter(content, source);
    if (frontmatter.name === undefined) {
        throw new Error(`Skill file "${source}" is missing required frontmatter field: name`);
    }
    if (frontmatter.description === undefined) {
        throw new Error(`Skill file "${source}" is missing required frontmatter field: description`);
    }
    const instructions = body.trim();
    if (instructions.length === 0) {
        throw new Error(`Skill file "${source}" has empty instructions body`);
    }
    return {
        name: frontmatter.name,
        description: frontmatter.description,
        instructions,
    };
}

/**
 * Split a Markdown file into YAML frontmatter and body.
 * Throws if the frontmatter is missing or malformed.
 */
function splitFrontmatter(content: string, source: string): { frontmatter: SkillFrontmatter; body: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (match === null) {
        throw new Error(`Skill file "${source}" is missing YAML frontmatter. Expected "---" delimited block at the start of the file.`);
    }
    const yamlText = match[1]!;
    const body = match[2]!;
    const frontmatter = parseSimpleYaml(yamlText, source);
    return { frontmatter, body };
}

/**
 * A minimal YAML parser for flat key-value frontmatter.
 * Only supports `key: value` pairs (no nesting, no arrays).
 * This avoids pulling in a YAML dependency for the simple frontmatter format.
 */
function parseSimpleYaml(text: string, source: string): SkillFrontmatter {
    const result: Partial<SkillFrontmatter> = {};
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        const colonIndex = trimmed.indexOf(':');
        if (colonIndex === -1) {
            throw new Error(`Skill file "${source}" has malformed frontmatter line: "${trimmed}"`);
        }
        const key = trimmed.slice(0, colonIndex).trim();
        const value = trimmed.slice(colonIndex + 1).trim();
        if (key === 'name' || key === 'description') {
            result[key] = value;
        }
    }
    return result as SkillFrontmatter;
}

/**
 * Load a single skill from a directory.
 *
 * Each skill is a directory containing a `skill.md` file with YAML frontmatter
 * and instruction body. The directory may also contain other files
 * (references, templates, scripts, etc.) that the skill instructions can
 * reference.
 *
 * Returns `undefined` if the directory does not contain a `skill.md` file
 * (i.e. it is not a skill directory).
 */
export async function loadSkillFromDir(dir: string): Promise<LoadedSkill | undefined> {
    const skillPath = join(dir, SKILL_FILE);
    let content: string;
    try {
        content = await readFile(skillPath, 'utf-8');
    } catch {
        // No skill.md in this directory — not a skill.
        return undefined;
    }
    const skill = parseSkillFile(content, skillPath);
    return { skill, source: dir };
}

/**
 * Load all skills from a directory.
 *
 * Each subdirectory under `dir` is treated as a skill. The subdirectory
 * must contain a `skill.md` file to be recognized as a skill.
 * Non-directory entries are skipped.
 *
 * Returns an empty array if the directory does not exist or contains no skills.
 */
export async function loadSkillsFromDirectory(dir: string): Promise<LoadedSkill[]> {
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch {
        // Directory does not exist — not an error, just no skills.
        return [];
    }

    const loaded: LoadedSkill[] = [];

    for (const entry of entries) {
        const entryPath = join(dir, entry);
        let isDir: boolean;
        try {
            isDir = (await stat(entryPath)).isDirectory();
        } catch {
            continue; // stat failed, skip
        }
        if (!isDir) continue;

        const result = await loadSkillFromDir(entryPath);
        if (result !== undefined) {
            loaded.push(result);
        }
    }

    return loaded;
}

/**
 * Default user-level skills directory: `~/.zeroagent/skills/`.
 */
export function userSkillsDir(): string {
    return join(homedir(), '.zeroagent', 'skills');
}

/**
 * Project-level skills directory: `{workdir}/.zeroagent/skills/`.
 */
export function projectSkillsDir(workdir: string): string {
    return join(workdir, '.zeroagent', 'skills');
}

/**
 * Load skills from both user-level and project-level directories.
 *
 * Skills are loaded in order: user-level first, then project-level.
 * Project-level skills with the same name as a user-level skill will
 * overwrite the earlier registration (last-write-wins).
 *
 * Returns the populated SkillRegistry and the list of loaded skills with
 * their source paths.
 */
export async function loadAllSkills(workdir: string): Promise<{
    registry: SkillRegistry;
    loaded: LoadedSkill[];
}> {
    const registry = new SkillRegistry();
    const loaded: LoadedSkill[] = [];

    const dirs = [
        { dir: userSkillsDir(), label: 'user' },
        { dir: projectSkillsDir(workdir), label: 'project' },
    ];

    for (const { dir } of dirs) {
        const skills = await loadSkillsFromDirectory(dir);
        for (const entry of skills) {
            registry.register(entry.skill);
            loaded.push(entry);
        }
    }

    return { registry, loaded };
}

/**
 * Load skills from disk and replace the contents of the provided registry.
 */
export async function loadSkills(workdir: string, target: SkillRegistry): Promise<LoadedSkill[]> {
    const { registry, loaded } = await loadAllSkills(workdir);
    target.clear();
    for (const skill of registry.list()) {
        target.register(skill);
    }
    return loaded;
}
