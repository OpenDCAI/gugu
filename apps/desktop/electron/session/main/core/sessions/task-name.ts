import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { listAgents, onAgentsSaved, type LocalAgentRecord } from '@gugu/core/local/state/agents';
import { agentsForOwner } from '@gugu/core/local/state/agentOwner';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { SESSIONPAGE_SESSION_CACHE_KEY } from '../sessionpage/sessionpage-session-agent';

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

/**
 * A bound session's name is its identity's name, held locally on the roster record (agents.json) —
 * `cache.name_pending` marks a local name not yet published to the cloud identity. This index is a
 * projection of the roster for the signed-in owner, rebuilt on every roster write; it stores nothing.
 */
export type BoundTaskName = { agentUserId: string; name: string; pending: boolean };

let owner: string | null = null;
let bound = new Map<string, BoundTaskName>();
let saves = 0;

function project(agents: readonly LocalAgentRecord[]): Map<string, BoundTaskName> {
  const next = new Map<string, BoundTaskName>();
  if (!owner) return next;
  for (const agent of agentsForOwner(agents, owner)) {
    const sessionId = agent.cache?.[SESSIONPAGE_SESSION_CACHE_KEY];
    if (typeof sessionId !== 'string' || !sessionId || !agent.gugu_user_id || !agent.name.trim()) continue;
    next.set(sessionId, { agentUserId: agent.gugu_user_id, name: agent.name.trim(), pending: agent.cache?.name_pending === true });
  }
  return next;
}

onAgentsSaved((agents) => { saves += 1; bound = project(agents); });

/** The host says whose identities name this host's sessions (sign-in, sign-out, account switch). */
export async function setTaskNameOwner(ownerUserId: string | null, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  owner = ownerUserId;
  const before = saves;
  const agents = ownerUserId ? await listAgents(env) : [];
  // A roster save during the read already projected a newer roster for this owner.
  if (saves === before) bound = project(agents);
}

export function boundTaskName(sessionId: string): BoundTaskName | undefined {
  return bound.get(sessionId);
}
