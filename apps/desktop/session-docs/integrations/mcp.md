# MCP

## Main Files

- `apps/desktop/electron/session/main/core/mcp/services/McpService.ts` — `listForAgent`: which servers a session in a given directory loads
- `apps/desktop/electron/session/main/core/mcp/utils/` — registration conversion
- `apps/desktop/electron/session/main/core/mcp/controller.ts` — `/mcp` session panel (`sessionPanel`), `listForAgent`
- `apps/desktop/src/session/renderer/features/mcp/components/` — `/mcp` session panel adapter

## Current Behavior

- There is no Library → MCP page (removed 2026-10-18, owner's choice): it listed each agent's config file without connecting to any server, so it could not say whether a server works, what tools it has, or why it fails. Rationale and native-client survey: gugu-base `notes/2026-10-18-library-mcp-purpose/`.
- Each agent has exactly one way it is read, and session start, the `/mcp` panel and the per-session record of "which servers this session started" all use it: its adapter reads the harness's config files following that harness's own merge rules (`readServers` + `readScopedServers`; the sources are cited in `impl/claude/mcp-scopes.ts`, `impl/codex/mcp-scopes.ts`, `impl/opencode/mcp-scopes.ts`). A file that does not parse counts as no servers.
- Gugu does not ask a harness CLI to list its servers: `codex mcp list` contacts every HTTP server for OAuth discovery and reads the OAuth keyring, and `opencode debug config` boots an instance that runs the project's plugins. Reading configs must not execute or contact anything.
- Gugu never writes users' agent config files; the adapter write gate only allows `'owned'` scopes (#5157).
- Per-session enable/disable lives in the `/mcp` panel (`mcp.sessionPanel`).

## Rules

- do not assume all providers support the same MCP transport types
- keep canonical MCP data in shared types and adapt at the edges
- do not send env, headers, or unmasked secrets to the renderer
