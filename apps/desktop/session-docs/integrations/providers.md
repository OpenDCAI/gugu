# Providers

## Source Of Truth

- `packages/session-plugins/src/agents/registry.ts`
- `packages/session-plugins/src/agents/impl/`
- `apps/desktop/electron/session/main/core/dependencies/dependency-managers.ts`
- `apps/desktop/electron/session/main/core/pty/`

## Current Providers (30)

codex, claude, grok, devin, qwen, droid, antigravity, cursor, copilot, amp, commandcode, gemini, opencode, hermes, auggie, kimi, kilocode, kiro, cline, continue, codebuff, mistral, junie, oh-my-pi, pi, qoder, mimocode, zero, zcode, codebuddy

## Current ACP-Capable Providers (24)

codex, claude, grok, devin, qwen, droid, cursor, copilot, gemini, opencode, hermes, auggie, kimi, kilocode, kiro, cline, mistral, junie, oh-my-pi, pi, qoder, mimocode, zcode, codebuddy

## Provider Metadata Includes

- provider metadata and icon assets
- host dependency detection, install, update, and uninstall descriptors
- prompt delivery behavior
- auto-approve, ACP, hooks, MCP, model, session, trust, and plugin capabilities

## Agent Hooks And Notifications

Agent activity, completion, and attention notifications come from explicit hooks or plugins
installed by `apps/desktop/electron/session/main/core/agent-hooks/`. Gugu does not infer agent status from terminal
output. If a provider has no hook/plugin integration for an event, the renderer should not show
or notify an inferred status for that event.

## Provider Runtime Notes

- Claude uses deterministic `--session-id` values for conversation isolation.
- Agents that cannot receive an interactive initial prompt via argv or stdin use keystroke
  injection — Gugu types the prompt into the TUI after startup.
- `apps/desktop/electron/session/main/core/agent-hooks/agent-hook-service.ts` forwards hook events to renderer windows and can show OS notifications. It also writes hook config files for hook-capable providers, including `.claude/settings.local.json`, `.qwen/settings.json`, and provider-specific global hook files.
- Qwen Code hooks use the documented Qwen settings schema in `.qwen/settings.json`. Gugu installs command hooks for permission requests and session end/stop events while preserving unrelated user hooks.

## Adding Or Changing A Provider

1. add or update the plugin in `packages/session-plugins/src/agents/impl/` and register it in
   `packages/session-plugins/src/agents/registry.ts`
2. update allowlisted agent env vars in `apps/desktop/electron/session/main/core/pty/pty-env.ts` if needed
3. add or update hook/plugin installation in `apps/desktop/electron/session/main/core/agent-hooks/` if the provider
   supports explicit events
4. validate detection behavior in `apps/desktop/electron/session/main/core/dependencies/`
5. add or update tests for any non-standard behavior
