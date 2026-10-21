# Architecture Overview

All paths are relative to `apps/desktop/`.

## Process Model

- `apps/desktop/electron/session/main/`: Electron main process — app lifecycle, RPC controllers, domain services, database, PTY orchestration, updater, SSH
- `src/preload/`: Electron preload bridge — exposes typed `invoke`, `eventSend`, `eventOn` to renderer
- `apps/desktop/src/session/renderer/`: React UI — app shell (`app/`), feature areas (`features/`), shared infrastructure (`lib/`), typed RPC client
- `apps/desktop/src/session/shared/`: Provider registry, IPC primitives (RPC + events), MCP types, skills types, shared domain types

## Boot Sequence

`apps/desktop/electron/session/main/index.ts` → app lifecycle → IPC/RPC registration → window creation → renderer

- `index.ts` — Loads `.env`, normalizes PATH, initializes database, registers all RPC controllers via `apps/desktop/electron/session/main/rpc.ts`, creates the main window.
- `apps/desktop/electron/session/main/rpc.ts` — Assembles the typed RPC router from domain controllers (`apps/desktop/electron/session/main/core/*/controller.ts`).
- `src/preload/index.ts` — Exposes `window.electronAPI` (`invoke`, `eventSend`, `eventOn`) via `contextBridge`.
- `apps/desktop/src/session/renderer/lib/ipc.ts` — Creates the typed RPC client and event emitter used throughout the renderer.

## Build Tooling

- 仓库根 `vite.config.mts` —— 主进程、preload、渲染层(含会话页第二个 input)都出自这一次构建。
- `vitest.config.ts` — Vitest config with five test projects: `node`, `main-db`, `fixtures`, `migrations`, and `browser` (Playwright-backed renderer tests).
- Single `tsconfig.json` (in `apps/desktop/`) for all app targets.

## Read Next

- Main process details: `main-process.md`
- Renderer details: `renderer.md`
- Shared modules and provider registry: `shared.md`
