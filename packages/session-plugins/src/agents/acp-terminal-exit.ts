import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { TerminalExit } from '@gugu/session-core/acp';

/**
 * Read how a command's process ended out of a provider's `_meta`.
 *
 * ACP's own route for this is a client-owned terminal: the agent calls
 * `terminal/create`, the client spawns the process and therefore knows first-hand
 * how it ended. Neither adapter we ship takes that route — both run the command
 * themselves and report the outcome in `_meta.terminal_exit` instead, so on those
 * two providers the client-terminal registry is never populated and there is no
 * first-hand reading to be had.
 *
 * `_meta` is by definition per-implementation, which is why this lives behind
 * each provider's EnrichHook rather than in the baseline decoder — a provider
 * has to say "I emit this" for it to be read, the same contract that governs
 * `parentToolCallId`. That the two adapters happen to agree on the shape is a
 * fact about them, not a protocol guarantee: claude-agent-acp's own source says
 * it emits this sequence "to match codex-acp's streaming lifecycle".
 *
 * Returns undefined unless a real exit is present. A `terminal_exit` block whose
 * code and signal are both absent says only "it ended", which is not a reading —
 * callers render nothing for it rather than inventing a zero.
 */
export function terminalExitFromMeta(raw: SessionUpdate): TerminalExit | undefined {
  const block = (raw._meta as { terminal_exit?: unknown } | null | undefined)?.terminal_exit;
  if (!block || typeof block !== 'object') return undefined;
  const { exit_code: exitCode, signal } = block as { exit_code?: unknown; signal?: unknown };
  const code = typeof exitCode === 'number' ? exitCode : null;
  const sig = typeof signal === 'string' ? signal : null;
  if (code === null && sig === null) return undefined;
  return { exitCode: code, signal: sig };
}
