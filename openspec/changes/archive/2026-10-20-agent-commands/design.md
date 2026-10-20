## Context

Chapter 8 (a copy of chapter 7) adds user-defined slash commands to the interactive REPL. Skills already demonstrate the "load markdown files from global + project directories" pattern: `skills/loader.ts` parses `skill.md` frontmatter (`name`, `description`) plus an instructions body, loaded from `~/.zeroagent/skills/` and `{workdir}/.zeroagent/skills/`. Commands are the user-facing mirror image: instead of injecting instructions for the model, a command is a **prompt template** that the user invokes by typing `/name args`, which the CLI expands and sends to the agent as a normal user prompt.

The REPL (`cli.ts`) currently handles three hardcoded slash commands (`/sessions`, `/resume`, `/clear`) before falling through to `agent.stream(prompt)`. Commands slot into this same dispatch point.

## Goals / Non-Goals

**Goals:**
- Load command templates from global (`~/.zeroagent/commands/*.md`) and project (`{workdir}/.zeroagent/commands/*.md`) directories
- Register, look up, and list commands in-memory via a `CommandRegistry`
- Expand templates with bash-style placeholders `$N` and `${N:-default}`
- Invoke commands in the REPL via `/name arg1 arg2` (whitespace-split args)
- Reload commands and skills via `/reload`
- Unknown commands produce an error and list available commands

**Non-Goals:**
- One-shot mode (`pnpm start "prompt"`) command support — commands are REPL-only
- Quote-aware argument splitting — args are split on whitespace only
- Bash parameter expansions beyond `$N` and `${N:-default}` (`$@`, `$0`, `${N-default}`, `${N/pat/sub}`, etc.)
- Model awareness of commands — commands are expanded client-side; the model only ever sees the expanded prompt
- Commands as agent-invocable tools — the `Agent` class is unchanged

## Decisions

### 1. Command name comes from frontmatter `name`, not the filename

**Rationale**: Consistent with skills, where the directory name is irrelevant and `name` is authoritative. Command files are `*.md` (not directories), so frontmatter keeps the name stable regardless of how the file is named or organized.

**Alternatives considered**:
- Filename as name (`review.md` → `/review`): simpler, but couples the command name to the filesystem and diverges from the skills convention.

### 2. Expansion happens in the CLI; the expanded text becomes the user prompt

**Rationale**: Commands are user-side ergonomics. The agent sees only the expanded prompt, so there is no change to `Agent`, `PromptRequestBuilder`, or the Responses request. When a session is active, the session records the expanded prompt — which is exactly what the model was given, so resumed context stays faithful.

**Alternatives considered**:
- Expand inside the `Agent` (e.g., detect leading `/name` in `stream()`): couples the agent to CLI concerns and would require passing a registry into the agent.
- Inject the command body as `instructions` rather than user content: more complex, and ambiguous when the command body contains tool-style placeholders; user-content semantics are simpler and predictable.

### 3. Standalone `CommandRegistry`, used by the CLI (not embedded in `Agent`)

**Rationale**: Commands are a CLI feature. The registry mirrors `SkillRegistry` (same register/get/list/has/remove/clear shape) but lives in `src/command/` and is consumed only by `cli.ts`.

**Alternatives considered**:
- Adding `agent.commands`: future-proofing for model-invoked commands, but YAGNI — the spec has no such requirement.

### 4. Built-in commands take precedence over user commands

**Rationale**: `/sessions`, `/resume`, `/clear`, `/reload` are reserved words handled before generic command dispatch. A user command named `sessions` cannot shadow the built-in, avoiding surprising behavior.

**Alternatives considered**:
- User commands override built-ins: risks breaking session management if a user defines `/sessions`.

### 5. Whitespace-only argument splitting

**Rationale**: Keeps parsing trivial (`prompt.split(/\s+/)`) and matches the spec's "空白切分" decision. Quote-aware splitting is a future enhancement.

**Alternatives considered**:
- Quote-aware splitting: nicer for multi-word args, but adds a tokenizer and edge cases (escaped quotes, mismatched quotes).

### 6. Placeholder semantics follow bash `$N` and `${N:-default}`

**Rationale**: `$N` is 1-indexed and substitutes the Nth argument, or the empty string if missing. `${N:-default}` substitutes the Nth argument when it is present (and non-empty), otherwise the literal `default`. Substitution runs in two passes — `${N:-default}` first, then `$N` — so a default value containing `$M` still resolves against the remaining args, while a missing `$N` never leaves stray `$` tokens behind.

**Alternatives considered**:
- Single combined regex: fragile ordering issues between the two forms.
- Erroring on missing `$N`: diverges from bash and complicates templates with optional trailing args.

### 7. Loader reads `*.md` files directly (not skill-style directories)

**Rationale**: A command is a single template file, not a bundle of supporting files. The loader iterates directory entries, keeps `.md` files, parses frontmatter + body, and skips everything else.

**Alternatives considered**:
- Directory-per-command with `command.md` inside: mirrors skills exactly, but is heavier than a one-file-per-command mental model needs.

### 8. Minimal YAML frontmatter parser, duplicated from `skills/loader.ts`

**Rationale**: The skills loader has a small `splitFrontmatter` + `parseSimpleYaml` (flat `key: value` only). Commands need the same for `name` and `description`. Rather than cross-coupling `skills/` and `command/`, the command loader carries its own copy — the duplication is ~20 lines and keeps each chapter's module self-contained.

**Alternatives considered**:
- Extract a shared `frontmatter.ts` util: cleaner, but touches `skills/loader.ts` (a drive-by refactor) and the tutorial values per-module self-containment.

### 9. `/reload` reuses the existing loaders

**Rationale**: `/reload` calls `loadCommands(workdir, commandRegistry)` and `loadSkills(workdir, agent.skills)` — the same functions the CLI already uses at startup — then prints the resulting counts. No new reload-specific code paths.

**Alternatives considered**:
- Dedicated reload logic inside the agent: unnecessary; the loaders already support in-place replacement (`clear()` + re-register).

## Risks / Trade-offs

- **Two-pass substitution can surprise users whose default text contains `$N`** → Mitigation: documented in the expansion spec; it is actually a feature (defaults may reference other args).
- **No quoting means multi-word args are impossible** → Mitigation: accepted scope for this chapter; users can fall back to typing the expanded prompt directly.
- **Frontmatter parser duplication may drift from the skills parser** → Mitigation: both are trivial and frozen for the tutorial; a future refactor can unify them.
- **`$10` is parsed as positional 10, not `$1` followed by `0`** → Mitigation: matches bash semantics; noted in the expansion spec.
- **Command name collisions among project files silently resolve last-write-wins** → Mitigation: consistent with skills; the registry `register()` overwrites and the loader processes files in readdir order.
