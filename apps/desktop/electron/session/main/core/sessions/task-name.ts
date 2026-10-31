import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';

/**
 * A task has one name: its agent identity's name. Until the session is bound to an identity that name
 * lives in the session's pending-bind record (`config.agentDisplayName`), written at creation, so every
 * session has a name from its first row and provisioning only ever binds the name the session carries.
 */
export interface TaskNamer {
  /**
   * The engine default (`<engine label> <serial>`), numbered and reserved by the identity host past
   * every bound identity and `taken` (the names this host's sessions already carry).
   */
  defaultName(provider: AgentProviderId, taken: readonly string[]): Promise<string>;
}

let namer: TaskNamer | null = null;

export function setTaskNamer(next: TaskNamer | null): void {
  namer = next;
}

export async function taskNameFor(provider: AgentProviderId, chosen?: string | null): Promise<string> {
  const name = chosen?.trim();
  if (name) return name;
  if (!namer) throw new Error('No task namer is installed on this host; a session cannot be created without a name');
  const taken = (await db.select({ config: sessions.config }).from(sessions))
    .map((row) => row.config?.agentDisplayName?.trim() ?? '')
    .filter(Boolean);
  const fallback = (await namer.defaultName(provider, taken)).trim();
  if (!fallback) throw new Error(`Task namer returned an empty default name for ${provider}`);
  return fallback;
}
