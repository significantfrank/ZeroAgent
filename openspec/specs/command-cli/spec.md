# command-cli Specification

## Purpose
TBD - created by archiving change agent-commands. Update Purpose after archive.
## Requirements
### Requirement: Commands are loaded in interactive mode
When the CLI starts in interactive mode, it SHALL load commands from the global and project directories into a `CommandRegistry` before entering the REPL loop.

#### Scenario: Startup loads registered commands
- **WHEN** the CLI starts in interactive mode and command files exist on disk
- **THEN** the registry SHALL contain those commands, available for use in the REPL

### Requirement: Slash command invocation
When a REPL input starts with `/` and matches a registered command, the CLI SHALL split the input on whitespace into the command name and its arguments, expand the command's template with those arguments, and pass the expanded text to the agent as the user prompt.

#### Scenario: Command expands and runs
- **WHEN** the user types `/review src/tools.ts` and a `review` command is registered with template `Review $1`
- **THEN** the agent SHALL receive `Review src/tools.ts` as its prompt

#### Scenario: Command with multiple arguments
- **WHEN** the user types `/review a.txt b.txt` and the `review` command template references `$1` and `$2`
- **THEN** both placeholders SHALL be substituted before the prompt is sent

### Requirement: Unknown command reports an error
When a REPL input starts with `/` but the name matches neither a built-in command nor a registered command, the CLI SHALL print an error and list the available commands (built-in and registered).

#### Scenario: Unknown slash command
- **WHEN** the user types `/nonexistent` and no such command is registered
- **THEN** the CLI SHALL print an error naming the unknown command and list the available commands

#### Scenario: Known built-in command still works
- **WHEN** the user types `/sessions`
- **THEN** the CLI SHALL run the built-in session listing rather than treat it as a user command

### Requirement: Built-in commands take precedence
Built-in commands (`/sessions`, `/resume`, `/clear`, `/reload`) SHALL be handled before user command dispatch, so a user command with the same name cannot shadow them.

#### Scenario: User command cannot shadow built-in
- **WHEN** a user registers a command named `clear`
- **THEN** typing `/clear` SHALL still run the built-in session-clear behavior

### Requirement: Reload command
The CLI SHALL support a `/reload` command that reloads both commands and skills from disk and reports how many of each were loaded.

#### Scenario: Reload picks up new files
- **WHEN** a new command file is added to disk while the REPL is running, then the user types `/reload`
- **THEN** the new command SHALL be available and the CLI SHALL report the reloaded command and skill counts

### Requirement: One-shot mode is unaffected
When the CLI is invoked with prompt arguments (non-interactive mode), it SHALL NOT load commands and SHALL NOT interpret slash-command syntax.

#### Scenario: One-shot mode ignores commands
- **WHEN** the CLI is invoked as `pnpm start "/review foo.ts"`
- **THEN** the text SHALL be sent to the agent as a plain prompt without command expansion

