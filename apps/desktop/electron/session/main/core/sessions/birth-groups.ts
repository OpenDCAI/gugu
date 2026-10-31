import type { BirthGroup } from '@shared/core/sessions/create-session';

/**
 * The chat an agent is born in (`session_spawn` chat_id, an App's `spawnAgent` chat), by its conversation — recorded at
 * the spawn, taken once when its identity is first minted (it joins that group then, as the group's rules allow). Kept
 * in memory only: a restart before the mint drops it, and an agent later removed from the group is never put back.
 */
const births = new Map<string, BirthGroup>();

export function rememberBirthGroup(sessionId: string, group: BirthGroup): void {
  births.set(sessionId, group);
}

export function takeBirthGroup(sessionId: string): BirthGroup | null {
  const group = births.get(sessionId) ?? null;
  births.delete(sessionId);
  return group;
}
