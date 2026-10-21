import type { SessionRuntime } from '@shared/core/sessions/sessions';

/**
 * Maps a conversation type to the corresponding tab kind so callers
 * don't have to branch on 'acp' vs 'pty' inline.
 */
export function sessionTabKind(
  type: SessionRuntime | undefined
): 'session' | 'acp-chat' {
  return type === 'acp' ? 'acp-chat' : 'session';
}
