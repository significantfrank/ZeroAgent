## Why

The interactive REPL currently ships only three hardcoded slash commands (`/sessions`, `/resume`, `/clear`). Users cannot define their own reusable prompt templates — every repeated workflow (review a file, summarize a diff, draft a commit message) must be retyped by hand each time. Chapter 8 adds user-defined **slash commands**: markdown files that expand into prompts with bash-style argument substitution, loaded from global and project directories — mirroring how skills are loaded and giving users a composable, version-controllable way to encode their own workflows.

## What Changes

- Add `src/command/` with a `CommandDefinition` type, a `CommandRegistry`, and a loader that parses markdown files with YAML frontmatter (`name`, `description`) and a prompt-template body
- Load commands from `~/.zeroagent/commands/*.md` (global) and `{workdir}/.zeroagent/commands/*.md` (project-level; project overrides global on name collision)
- Support bash-style placeholders in templates: `$N` (Nth positional argument, empty string if missing) and `${N:-default}` (Nth argument with a fallback default)
- In the REPL, `/commandName arg1 arg2` splits arguments on whitespace, expands the template, and sends the result to the agent as the user prompt; unknown commands print an error and list available commands
- Add a `/reload` command that reloads both commands and skills
- Commands are REPL-only (not one-shot mode); built-in commands (`/sessions`, `/resume`, `/clear`, `/reload`) take precedence over user commands

## Capabilities

### New Capabilities
- `command-loader`: parse command markdown files (frontmatter + template body) and load them from global/project directories
- `command-registry`: in-memory registry to register, look up, list, and remove commands
- `command-expansion`: bash-style placeholder substitution (`$N`, `${N:-default}`) over command templates
- `command-cli`: REPL integration — parse `/command` input, expand and run, report unknown commands, and reload via `/reload`

### Modified Capabilities
<!-- none — new feature, no existing specs to modify -->

## Impact

- **New files**: `chapter8/src/command/types.ts`, `registry.ts`, `loader.ts`, `expand.ts`, `index.ts`
- **Modified files**: `chapter8/src/cli.ts` (REPL dispatch and `/reload`)
- **Impacted package**: `@zero-agent/chapter8` only
- **No new dependencies**: Node built-ins only (`node:fs/promises`, `node:path`, `node:os`)
- **Tests**: new `chapter8/test/command.test.ts`; existing tests remain green (commands are additive and REPL-only)
- **No breaking changes**: existing built-in slash commands and plain prompts are unaffected
