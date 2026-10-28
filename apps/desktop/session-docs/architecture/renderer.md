# Renderer

All paths are relative to `apps/desktop/`.

## Main Entry Points

- `apps/desktop/src/session/renderer/main.tsx`: renderer bootstrap
- `apps/desktop/src/session/renderer/App.tsx`: top-level provider composition
- `apps/desktop/src/session/renderer/app/workspace.tsx`: main post-onboarding shell
- `apps/desktop/src/session/renderer/app/view-registry.ts`: view definitions and navigation guards; switches between views
- `apps/desktop/src/session/renderer/lib/ipc.ts`: typed RPC client (`rpc`) and event emitter (`events`) used throughout renderer

## App Shell (`apps/desktop/src/session/renderer/app/`)

- `workspace.tsx`, `home-view.tsx`, `welcome.tsx` — shell and top-level views
- `modal-registry.ts` — central modal registry; all modals are registered here
- `view-registry.ts` — central view registry; all views are registered here
- `app-menu-events.tsx` — native app menu event wiring

## Feature Areas (`apps/desktop/src/session/renderer/features/`)

- `tasks/` — task experience: `conversations/`, `diff-view/`, `editor/` (Monaco, file tree),
  `terminals/`, `create-session-modal/`, `issue-context/`, `session-config/`, `tabs/`, `stores/`
  (MobX task stores and `session-selectors.ts`), `hooks/`, `view/`
- `projects/` — project management, settings panel, branch selector; `stores/` holds
  project stores and `project-selectors.ts`
- `sidebar/` — app sidebar
- `mcp/` — MCP server management UI (`mcp-view.tsx`, `components/`)
- `skills/` — skills catalog and management
- `integrations/` — integration management (GitHub, GitLab, Jira, Linear, ...)
- `settings/` — settings view
- `automations/`, `browser/`, `command-palette/`, `library/`

## Shared Renderer Infrastructure (`apps/desktop/src/session/renderer/lib/`)

- `ipc.ts` — typed RPC client and event emitter
- `modal/` — modal provider, renderer, store, and close-guard infrastructure
- `layout/` — layout, navigation, and panel drag providers
- `commands/` — command registry (`registry.ts`) and view-level `commandProvider` hooks
- `pty/` — frontend PTY sessions, pool provider, panes, prompt injection
- `monaco/`, `editor/` — Monaco editor integration
- `stores/` — cross-feature stores (navigation, dependencies, resource monitor, ...)
- `providers/`, `hooks/`, `components/`, `ui/`, `theme/` — shared providers, hooks, and UI primitives

## Tests

- Renderer unit tests: `apps/desktop/src/session/renderer/tests/`
- Playwright-backed browser tests: `apps/desktop/src/session/renderer/tests/browser/`

## When Editing Here

- Check `agents/conventions/renderer-patterns.md` for modal, view, PTY frontend, and store patterns.
- Call RPC methods via the typed `rpc` client from `apps/desktop/src/session/renderer/lib/ipc.ts`
  (alias `@renderer/lib/ipc`), e.g. `rpc.sessionCreate.create(...)`.
- New modals must be registered in `apps/desktop/src/session/renderer/app/modal-registry.ts`.
- New views must be registered in `apps/desktop/src/session/renderer/app/view-registry.ts`.
- The preload bridge (`src/preload/index.ts`) exposes only `invoke`, `eventSend`,
  `eventOn`, and `getPathForFile` on `window.electronAPI`; keep renderer-main calls on
  typed RPC and typed events.
