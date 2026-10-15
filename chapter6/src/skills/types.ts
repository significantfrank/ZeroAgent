import type { FunctionTool } from '../types.ts';

/**
 * Definition of a skill that can be loaded by the agent.
 *
 * Skills are reusable capabilities that augment the agent with domain-specific
 * instructions and optional tools. Each skill is a directory containing a
 * `skill.md` file with YAML frontmatter, loaded from the filesystem.
 */
export type SkillDefinition = {
    /** Unique name of the skill (kebab-case). */
    name: string;
    /** Human-readable description of what the skill does. */
    description: string;
    /** Instruction text injected into the system prompt when the skill is active. */
    instructions: string;
    /** Optional tools that this skill exposes to the agent. */
    tools?: readonly FunctionTool[];
};

/**
 * Shape of the YAML frontmatter parsed from a skill Markdown file.
 */
export type SkillFrontmatter = {
    name: string;
    description: string;
};

/**
 * Result of loading a skill from the filesystem.
 */
export type LoadedSkill = {
    /** The skill definition. */
    skill: SkillDefinition;
    /** Absolute path of the skill directory the skill was loaded from. */
    source: string;
};
