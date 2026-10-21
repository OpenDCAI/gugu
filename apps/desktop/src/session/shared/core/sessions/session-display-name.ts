import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { formatSessionTitleForDisplay } from './session-title-utils';

export type SessionDisplayNameInput = {
  /** Canonical session-page roster/contact name, when the session has an addressable identity. */
  identityName?: string | null;
  /** Explicit session_spawn title, also persisted as the agent name. */
  explicitName?: string | null;
  providerId?: AgentProviderId | null;
  title?: string | null;
};

/**
 * Resolve one display name for every session surface.
 *
 * The roster/contact name is the authoritative addressable identity. Explicit spawn names are the
 * same fact on a session row; a formatted conversation title is only the side-chat/no-identity
 * projection. Keeping the precedence here prevents the envelope, @ menu, and transcript pill from
 * inventing separate names for the same session id.
 */
export function resolveSessionDisplayName(
  input: SessionDisplayNameInput,
): string | null {
  const identityName = input.identityName?.trim();
  if (identityName) return identityName;

  const explicitName = input.explicitName?.trim();
  if (explicitName) return explicitName;

  const title = input.title?.trim();
  if (!title || !input.providerId) return null;
  const formatted = formatSessionTitleForDisplay(input.providerId, title).trim();
  return formatted || null;
}
