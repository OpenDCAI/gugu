# Main Process

## Structure

The main process is organized into domain modules under `apps/desktop/electron/session/main/core/`. Each domain typically has a `controller.ts` (RPC handlers) and service/implementation files.

## Domain Modules (`apps/desktop/electron/session/main/core/`)

- **account** — account service, credential store, provider token registry
- **agent-hooks** — HTTP hook server for agent callbacks, event enrichment, OS notifications, hook/plugin config writer
- **app** — App lifecycle service and controller
- **conversations** — Conversation CRUD and session start
- **dependencies** — CLI agent detection, probing, dependency management
- **editor** — Editor buffer service for Monaco integration
- **fs** — Filesystem operations with provider pattern (`local-fs.ts`, `ssh-fs.ts`)
- **git** — Git operations (`git-service.ts`, `git-repo-utils.ts`, `detectGitInfo.ts`)
- **github** — GitHub auth, PRs, issues, repos (via `gh` CLI)
- **jira** — Jira integration
- **linear** — Linear integration
- **mcp** — MCP service, adapters, config IO, catalog
- **projects** — Project management with provider pattern (`local-project-provider.ts`), worktree service, project settings, CRUD operations
- **pty** — PTY lifecycle (`local-pty.ts`, `ssh2-pty.ts`), session registry, env setup, spawn utilities
- **repository** — Repository controller
- **settings** — App settings service and schema, provider settings (separate controller)
- **shared** — Shared utilities (OAuth flow)
- **skills** — Skills service and controller
- **ssh** — SSH connection management, credentials, config parsing, client proxy
- **tasks** — creating a session (`sessionCreate.createSession`), workspace provisioning and mounts, attachments (the directory keeps its name until the PR-2 rename; there is no task entity)
- **terminals** — Terminal lifecycle with provider pattern (`local-terminal-provider.ts`, `ssh-terminal-provider.ts`), lifecycle scripts
- **updates** — Auto-update service

## Other Main Process Areas

- `apps/desktop/electron/session/main/app/` — Menu, protocol handler, window creation
- `apps/desktop/electron/session/main/lib/` — Logger, file logger, events, hookable, host IPC, rate limiter, retry, RPC logging, stage ledger
- `apps/desktop/electron/session/main/db/` — Database schema and initialization
- `apps/desktop/electron/session/main/utils/` — Shell environment, shell escaping, child process env, external links
- `apps/desktop/electron/session/main/core/agent-hooks/` — Hook server, event enrichment, OS notifications, hook/plugin config writer

## IPC / RPC Structure

- All domain controllers are assembled into a typed RPC router in `apps/desktop/electron/session/main/rpc.ts`.
- RPC primitives live in `apps/desktop/src/session/shared/ipc/rpc.ts` (`createRPCRouter`, `createRPCController`, `createRPCClient`).
- Event primitives live in `apps/desktop/src/session/shared/ipc/events.ts`.
- The preload bridge (`src/preload/index.ts`) exposes only `invoke`, `eventSend`, `eventOn`, and `getPathForFile`; there are no other manual IPC handlers.

## When Editing Here

- Check `agents/conventions/main-patterns.md` for controller, service, Result type, and event patterns.
- Check `agents/conventions/ipc.md` for the RPC controller pattern and typing rules.
- Check `agents/risky-areas/pty.md` before touching PTY or provider spawn behavior.
- Check `agents/risky-areas/database.md` before changing persistence or migrations.
