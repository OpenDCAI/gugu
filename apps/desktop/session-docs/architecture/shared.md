# Shared Modules

## Main Shared Areas

- Agent/provider DTOs:
  - `apps/desktop/src/session/shared/core/agents/agent-payload.ts`
  - provider metadata and capabilities are sourced from `packages/session-plugins/src/agents/registry.ts`
- IPC primitives:
  - `apps/desktop/src/session/shared/ipc/rpc.ts` — typed RPC router, controller, and client
  - `apps/desktop/src/session/shared/ipc/events.ts` — typed event emitter
- Typed event definitions:
  - `apps/desktop/src/session/shared/events/` — `agentEvents.ts`, `appEvents.ts`, `editorEvents.ts`, `fsEvents.ts`, `githubEvents.ts`, `hostPreviewEvents.ts`, `lifecycleEvents.ts`, `ptyEvents.ts`, `sshEvents.ts`
- MCP types:
  - `apps/desktop/src/session/shared/mcp/`
- Skills types and validation:
  - `apps/desktop/src/session/shared/skills/`
- Domain type modules (flat files):
  - `sessions.ts`, `fs.ts`, `git.ts`, `github.ts`, `hostPreview.ts`, `lifecycle.ts`, `projects.ts`, `pull-requests.ts`, `ssh.ts`, `create-session.ts`, `terminals.ts`, `urls.ts`, `utils.ts`
- PTY helpers:
  - `ptySessionId.ts` (provider-aware PTY ID parsing lives in main under `apps/desktop/electron/session/main/core/pty/`)
- App settings types:
  - `app-settings.ts`

## Path Aliases

别名的单一来源是 `apps/desktop/electron/sessionpage/emdash-aliases.mjs`,由仓库根的 `tsconfig.json`、
`vite.config.mts`、`vitest.config.ts` 与 esbuild 配方共同引用(#2802 起不再各抄一份):

| Alias | Resolves to |
| --- | --- |
| `@/*` | `src/*` |
| `@renderer/*` | `apps/desktop/src/session/renderer/*` |
| `@main/*` | `apps/desktop/electron/session/main/*` |
| `@shared/*` | `apps/desktop/src/session/shared/*` |
| `@root/*` | `./*` |

别名在构建期由 vite/esbuild 解析,运行时不打补丁。

## Provider Metadata Rules

When adding a provider:

1. add or update its plugin in `packages/session-plugins/src/agents/impl/` and register it in
   `packages/session-plugins/src/agents/registry.ts`
2. add any required env passthrough in `apps/desktop/electron/session/main/core/pty/pty-env.ts`
3. add or update hook/plugin installation in `apps/desktop/electron/session/main/core/agent-hooks/` if the provider
   supports explicit events
4. update renderer surfaces that consume agent metadata from `rpc.agents.*`
5. add tests for non-standard spawn or detection behavior
