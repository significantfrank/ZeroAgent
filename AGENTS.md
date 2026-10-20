# ZeroAgent — Agent Instructions

## Project Overview

ZeroAgent is a multi-chapter TypeScript tutorial series ("从零构建Agent") demonstrating a ReAct agent loop on the OpenAI Responses API. The repo is a pnpm monorepo.

## Tech Stack
- **Package manager**: pnpm 11 (`pnpm-workspace.yaml`, `workspace:*` links)
- **Build**: `tsc -b` (project references, composite)
- **Dependencies**: zero runtime deps for the core library; dev deps are `typescript` + `@types/node` only


## Conventions


## Rules

- Never break prompt caching or message role alternation
- Match existing code style — no drive-by refactors
- Run `pnpm typecheck` and `pnpm test` before declaring work done
- Don't commit or push unless asked
- Leave `.env` and credential files alone
