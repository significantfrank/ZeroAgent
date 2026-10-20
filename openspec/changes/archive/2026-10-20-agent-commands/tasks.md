## 1. Command module scaffold

- [x] 1.1 Create `chapter8/src/command/types.ts` with `CommandDefinition`, `CommandFrontmatter`, `LoadedCommand` types
- [x] 1.2 Create `chapter8/src/command/registry.ts` with `CommandRegistry` (register/get/list/names/has/remove/clear)
- [x] 1.3 Create `chapter8/src/command/index.ts` re-exporting the public API

## 2. Loader

- [x] 2.1 Create `chapter8/src/command/loader.ts` with `parseCommandFile` (frontmatter split + flat YAML `name`/`description` + template body)
- [x] 2.2 Add `loadCommandFromFile` (reads one `.md` file, returns `LoadedCommand` or `undefined`)
- [x] 2.3 Add `loadCommandsFromDirectory` (scans a dir, loads `*.md`, skips non-`.md` and missing dirs)
- [x] 2.4 Add `userCommandsDir`, `projectCommandsDir`, `loadAllCommands`, and `loadCommands` (clear + re-register)

## 3. Template expansion

- [x] 3.1 Create `chapter8/src/command/expand.ts` with `expandTemplate` implementing `${N:-default}` before `$N`
- [x] 3.2 Re-export `expandTemplate` from `chapter8/src/command/index.ts`

## 4. CLI integration

- [x] 4.1 In `chapter8/src/cli.ts`, import command modules and load commands at interactive-mode startup
- [x] 4.2 Add generic slash-command dispatch in the REPL loop (split on whitespace, expand, run) after built-in command checks
- [x] 4.3 Add unknown-command handling (error + list built-in and registered commands)
- [x] 4.4 Add `/reload` built-in that reloads commands and skills and prints counts

## 5. Tests

- [x] 5.1 Create `chapter8/test/command.test.ts` covering parser (valid/missing name/missing description/missing frontmatter/empty body)
- [x] 5.2 Add loader tests (directory scan, non-`.md` skip, missing dir, project-overrides-global, in-place reload)
- [x] 5.3 Add registry tests (register/get/overwrite/list/names/has/remove/clear)
- [x] 5.4 Add expansion tests (`$N`, `${N:-default}`, missing arg, empty default, default-before-plain order, unsupported syntax passthrough)

## 6. Verification

- [x] 6.1 Run `pnpm --filter @zero-agent/chapter8 typecheck`
- [x] 6.2 Run `pnpm --filter @zero-agent/chapter8 test` (all suites green)
- [x] 6.3 Update `chapter8/README.md` documenting the command feature
