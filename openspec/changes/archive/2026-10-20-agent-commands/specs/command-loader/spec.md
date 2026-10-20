## ADDED Requirements

### Requirement: Command file format
A command file SHALL be a Markdown file with YAML frontmatter containing `name` and `description` fields, followed by a template body. The frontmatter SHALL be delimited by `---` lines, and the template body SHALL be the text after the closing delimiter.

#### Scenario: Valid command file parses
- **WHEN** `parseCommandFile` reads a file with frontmatter `name: review` and `description: Review a file`, followed by a non-empty template body
- **THEN** it SHALL return a command with `name` `review`, `description` `Review a file`, and the template body as its `template`

#### Scenario: Missing name field throws
- **WHEN** a command file has frontmatter without a `name` field
- **THEN** `parseCommandFile` SHALL throw an error indicating the `name` field is missing

#### Scenario: Missing description field throws
- **WHEN** a command file has frontmatter without a `description` field
- **THEN** `parseCommandFile` SHALL throw an error indicating the `description` field is missing

#### Scenario: Missing frontmatter throws
- **WHEN** a command file does not start with a `---` delimited frontmatter block
- **THEN** `parseCommandFile` SHALL throw an error indicating frontmatter is missing

#### Scenario: Empty template body throws
- **WHEN** a command file has valid frontmatter but a blank or whitespace-only template body
- **THEN** `parseCommandFile` SHALL throw an error indicating the template body is empty

### Requirement: Load commands from a directory
The loader SHALL scan a directory and load every `*.md` file as a command. Non-`.md` files and subdirectories SHALL be ignored. A missing or unreadable directory SHALL yield an empty result rather than an error.

#### Scenario: Loads all markdown files
- **WHEN** `loadCommandsFromDirectory` scans a directory containing `review.md` and `commit.md`
- **THEN** it SHALL return two loaded commands with the names and templates from their frontmatter

#### Scenario: Ignores non-markdown files
- **WHEN** a directory contains `notes.txt` and `review.md`
- **THEN** only `review.md` SHALL be loaded; `notes.txt` SHALL be skipped

#### Scenario: Missing directory yields empty list
- **WHEN** `loadCommandsFromDirectory` scans a path that does not exist
- **THEN** it SHALL return an empty array without throwing

### Requirement: Global commands directory
The global commands directory SHALL be `~/.zeroagent/commands/`.

#### Scenario: Global directory resolves under home
- **WHEN** `userCommandsDir()` is called
- **THEN** it SHALL return the path `~/.zeroagent/commands` (resolved to the current user's home directory)

### Requirement: Project commands directory
The project commands directory SHALL be `{workdir}/.zeroagent/commands/`.

#### Scenario: Project directory resolves under workdir
- **WHEN** `projectCommandsDir('/projects/foo')` is called
- **THEN** it SHALL return `/projects/foo/.zeroagent/commands`

### Requirement: Load all commands with project override
`loadAllCommands(workdir)` SHALL load global commands first, then project commands, into a single registry. When a project command has the same `name` as a global command, the project command SHALL replace the global one.

#### Scenario: Project command overrides global command
- **WHEN** both `~/.zeroagent/commands/review.md` and `{workdir}/.zeroagent/commands/review.md` define a command named `review`
- **THEN** the registry SHALL contain the project-level `review` command

#### Scenario: Global-only command survives
- **WHEN** a command exists only in the global directory and no project command shares its name
- **THEN** the command SHALL be present in the registry

### Requirement: Load commands into an existing registry
`loadCommands(workdir, target)` SHALL clear the target registry and re-register all commands from global and project directories, returning the loaded commands.

#### Scenario: Registry is replaced in place
- **WHEN** `loadCommands` is called on a registry that already contains a stale command not present on disk
- **THEN** the stale command SHALL be removed and the registry SHALL contain exactly the commands currently on disk
