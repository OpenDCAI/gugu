import type { CanonicalHookEvent } from '@gugu/session-core/agents/plugins';
import { defaultHookEventParser } from '@gugu/session-core/agents/plugins/helpers';

// Guarded and silenced for the same reasons the shared POSIX helper is (see
// session-core/agents/plugins/helpers/hooks.ts). It is session-scoped now, but pre-#2804
// builds wrote this same value into the user's global config, where it also ran for
// codex sessions gugu never started (variables absent ⇒ URL collapses to port 80).
const LEGACY_CODEX_NOTIFY_COMMAND = [
  'bash',
  '-c',
  'if [ -n "$GUGU_HOOK_PORT" ] && [ -n "$GUGU_HOOK_TOKEN" ] && [ -n "$GUGU_PTY_ID" ]; then ' +
    'curl -sf -o /dev/null -X POST ' +
    "-H 'Content-Type: application/json' " +
    '-H "X-Gugu-Token: $GUGU_HOOK_TOKEN" ' +
    '-H "X-Gugu-Pty-Id: $GUGU_PTY_ID" ' +
    '-H "X-Gugu-Event-Type: notification" ' +
    '-d "$1" ' +
    '"http://127.0.0.1:$GUGU_HOOK_PORT/hook" || true; fi',
  '_',
];

/**
 * Codex's `notify` callback is not gated by interactive hook trust. Scoping it to the
 * session gugu launched — rather than writing the user's global config.toml — keeps
 * completion tracking ours and leaves a user's own `notify` untouched.
 *
 * @@@5380 一个值,两种载法,别再各写一份。
 * app-server 那两条腿(自建 ACP 桥 / session-TUI)把它当 thread-open `config` map 的一个键送,
 * 见 `codexNotifyConfigValue`;只有**没有** config 通道的那条腿(prompt 直起 TUI)才用
 * `-c notify=…`。两者共用下面这一份命令。
 */
export function codexNotifyConfigValue(): string[] {
  return [...LEGACY_CODEX_NOTIFY_COMMAND];
}

/** `-c notify=…` 形态,供没有 thread-open `config` map 的 prompt/TUI 腿使用。 */
export function makeCodexNotifyConfigOverride(): string {
  return `notify=${JSON.stringify(codexNotifyConfigValue())}`;
}

/**
 * Codex sends `{ type: 'agent-turn-complete' }` as its stop signal instead
 * of a plain 'stop' event type, and uses fixed `notification_type` values
 * in its hook payloads rather than piping JSON.
 */
function parseCodexHookEvent(eventType: string, body: Record<string, unknown>): CanonicalHookEvent {
  if (eventType === 'session-start') {
    const candidates = [body.session_id, body.resource_id, body.resourceId, body.sessionId];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return { kind: 'session', providerSessionId: candidate.trim() };
      }
    }
    return { kind: 'ignore' };
  }

  if (eventType === 'notification') {
    const nt = body.notification_type;
    if (nt === 'idle_prompt' || (typeof nt !== 'string' && body.type === 'agent-turn-complete')) {
      return { kind: 'status', type: 'stop' };
    }
    if (nt === 'permission_prompt') {
      return { kind: 'status', type: 'notification', notificationType: 'permission_prompt' };
    }
  }

  return defaultHookEventParser(eventType, body);
}

/**
 * codex 的 hook 行为只剩**解析**:回调由会话级的 `notify` 覆盖交付(见上面 `codexNotifyConfigValue`,
 * descriptor `hooks.scope = 'session'`),❌ 不挂任何往 `~/.codex/config.toml` 写的写入器(#6195)。
 */
export function buildCodexHookConfig() {
  return { parseHookEvent: parseCodexHookEvent };
}
