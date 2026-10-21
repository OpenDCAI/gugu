# Risky Area: PTY And Sessions

## Main Files

- `apps/desktop/electron/session/main/core/pty/` — `local-pty.ts`, `ssh2-pty.ts`, `pty.ts`, `pty-env.ts`, `pty-session-registry.ts`, `exit-signals.ts`, `controller.ts`
- `apps/desktop/electron/session/main/core/terminals/` — terminal lifecycle, local and SSH terminal providers
- `apps/desktop/electron/session/main/core/agent-hooks/` — hook server, event enrichment, OS notifications, hook config writer

## Core Risks

- PTY cleanup and exit handling
- resize behavior
- shell quoting and Windows command wrapping
- tmux lifecycle
- provider-specific resume/session behavior
- env passthrough safety

## Rules

- use the allowlisted env passthrough model in `apps/desktop/electron/session/main/core/pty/pty-env.ts`
- do not weaken quoting or spawn behavior casually
- validate both direct spawn and shell-wrapped spawn cases when changing PTY startup logic
- confirm renderer event flow if hook/plugin payload or notification behavior changes
- On Windows, providers declaring `windowsConsoleColorFallback: screen-buffer` are wrapped inside
  the Windows spawn resolver. The launcher sets ConPTY console attributes before starting the
  already-resolved target, preserves raw `cmd.exe /d /s /c` syntax for `.cmd`/`.bat` shims, forwards
  the child exit code, and relies on closing the ConPTY session to reap the complete process tree.
