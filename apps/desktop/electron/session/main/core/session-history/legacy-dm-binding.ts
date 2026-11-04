import { eq } from 'drizzle-orm';
import { listAgents, type LocalAgentRecord } from '@gugu/core';
import { agentOwnerUserId } from '@gugu/core/local/state/agentOwner';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { SESSIONPAGE_SESSION_CACHE_KEY, SESSIONPAGE_PARKED_SESSION_CACHE_KEY } from '../sessionpage/sessionpage-session-agent';

/** Historical lookup never provisions an identity, restores a session or trusts a directory/name. */
export function legacyDmBinding(
  roster: readonly LocalAgentRecord[], ownerUserId: string, sessionId: string,
): { agentUserId: string; sessionId: string } | null {
  if (!ownerUserId.trim() || !sessionId.trim()) throw new Error('A signed-in owner and a persisted session are required');
  const candidates = roster.filter(agent => agentOwnerUserId(agent) === ownerUserId
    && (agent.cache?.[SESSIONPAGE_SESSION_CACHE_KEY] === sessionId
      || agent.cache?.[SESSIONPAGE_PARKED_SESSION_CACHE_KEY] === sessionId));
  if (candidates.length > 1) throw new Error('The historical session has more than one identity binding');
  const agent = candidates[0];
  if (!agent?.gugu_user_id) return null;
  const bindings = roster.filter(row => row.gugu_user_id === agent.gugu_user_id);
  if (bindings.length !== 1) throw new Error('The historical agent has more than one local binding');
  return { agentUserId: agent.gugu_user_id, sessionId };
}

export async function readLegacyDmBinding(input: { ownerUserId: string; sessionId: string }) {
  const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, input.sessionId));
  if (rows.length !== 1) throw new Error('The historical session does not exist on this machine');
  return legacyDmBinding(await listAgents(process.env, { includeGuests: true }), input.ownerUserId, input.sessionId);
}
