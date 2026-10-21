# TypeScript And React Conventions

## TypeScript

- strict mode is enabled in `apps/desktop/tsconfig.json`
- always use explicit types, do not use `any`
- prefer module imports at the top of the file, never use require()
- single `tsconfig.json` (in `apps/desktop/`) for all app targets (main, preload, renderer, shared)

## Renderer

Paths are relative to `apps/desktop/`.

- functional React components and hooks
- app shell and the modal/view registries under `apps/desktop/src/session/renderer/app/`
- feature UI under `apps/desktop/src/session/renderer/features/<feature>/`
- shared infrastructure under `apps/desktop/src/session/renderer/lib/` (IPC client, modal and layout
  systems, commands, PTY frontend, providers, hooks, stores, UI primitives)

## Naming

- components: PascalCase
- hooks: `useX` camelCase or existing patterns like `use-toast.ts`
- tests: `*.test.ts`
