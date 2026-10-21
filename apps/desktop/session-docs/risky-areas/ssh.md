# Risky Area: SSH And Shell Escaping

## Main Files

- `apps/desktop/electron/session/main/core/ssh/` — `ssh-connection-manager.ts`, `ssh-credential-service.ts`, `ssh-client-proxy.ts`, `sshConfigParser.ts`, `build-connect-config.ts`, `controller.ts`
- `apps/desktop/electron/session/main/core/fs/impl/ssh-fs.ts`
- `apps/desktop/electron/session/main/core/pty/ssh2-pty.ts`
- `apps/desktop/electron/session/main/core/terminals/impl/ssh-terminal-provider.ts`
- `apps/desktop/electron/session/main/utils/shellEscape.ts`

## Rules

- treat remote shell construction as security-sensitive
- use shared escaping and validation helpers
- do not bypass path-safety or shell validation helpers
- verify how a change affects both connection setup and command execution
