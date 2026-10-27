# ZeroAgent — Agent Instructions

## Project Overview

ZeroAgent is a multi-chapter TypeScript tutorial series ("从零构建Agent") demonstrating a ReAct agent loop on the OpenAI Responses API. The repo is a pnpm monorepo.

## Tech Stack
- **Package manager**: pnpm 11 (`pnpm-workspace.yaml`, `workspace:*` links)
- **Build**: `tsc -b` (project references, composite)
- **Dependencies**: zero runtime deps for the core library; dev deps are `typescript` + `@types/node` only


## Conventions
- **编码**：不要满足于实现，要考虑代码的可维护性和可理解性，代码要在类、包层次体现高类聚
- **测试**：不需要很多的test cases，只关注关键的happy cases即可
- **验证**：实现完一个功能，要通过`pnpm --filter @zero-agent/chapterXX start` 启动Agent进行功能验证

## Rules

- Never break prompt caching or message role alternation
- Match existing code style — no drive-by refactors
- Run `pnpm typecheck` and `pnpm test` before declaring work done
- Don't commit or push unless asked
