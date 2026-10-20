/**
 * Definition of a user-invoked slash command.
 *
 * A command is a Markdown file with YAML frontmatter (`name`, `description`)
 * and a prompt-template body. The template supports bash-style placeholders
 * (`$1`, `$2`, `${1:-default}`) that are expanded by the CLI before the
 * prompt is sent to the agent.
 */
export type CommandDefinition = {
    /** Unique name of the command (invoked as `/name`). */
    name: string;
    /** Human-readable description shown when listing commands. */
    description: string;
    /** Prompt template body with positional placeholders. */
    template: string;
};

/**
 * Shape of the YAML frontmatter parsed from a command Markdown file.
 */
export type CommandFrontmatter = {
    name: string;
    description: string;
};

/**
 * Result of loading a command from the filesystem.
 */
export type LoadedCommand = {
    /** The command definition. */
    command: CommandDefinition;
    /** Absolute path of the `.md` file the command was loaded from. */
    source: string;
};
