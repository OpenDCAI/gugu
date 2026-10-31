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
  /**
   * Rename a bound session's identity: written on the roster first (pending until published), then
   * published to the cloud identity. A failed publish keeps the local name pending; it never throws
   * for being offline.
   */
  renameBound(sessionId: string, agentUserId: string, name: string): Promise<void>;
}

let namer: TaskNamer | null = null;

export function setTaskNamer(next: TaskNamer | null): void {
  namer = next;
}

export function taskNamer(): TaskNamer {
  if (!namer) throw new Error('No task namer is installed on this host');
  return namer;
}

export async function taskNameFor(provider: AgentProviderId, chosen?: string | null): Promise<string> {
  const name = chosen?.trim();
  if (name) return name;
  const taken = (await db.select({ config: sessions.config }).from(sessions))
    .map((row) => row.config?.agentDisplayName?.trim() ?? '')
    .filter(Boolean);
  const fallback = (await taskNamer().defaultName(provider, taken)).trim();
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

export type TaskNameChange = { sessionId: string; previous?: BoundTaskName; next?: BoundTaskName };
type TaskNamesChangedListener = (changes: readonly TaskNameChange[]) => void;
const changedListeners = new Set<TaskNamesChangedListener>();

/** One event for every change of a bound session's name, including binding and unbinding. */
export function onTaskNamesChanged(listener: TaskNamesChangedListener): () => void {
  changedListeners.add(listener);
  return () => { changedListeners.delete(listener); };
}

function replace(next: Map<string, BoundTaskName>): void {
  const changes: TaskNameChange[] = [];
  for (const [sessionId, entry] of next) {
    const previous = bound.get(sessionId);
    if (previous?.name !== entry.name) changes.push({ sessionId, previous, next: entry });
  }
  for (const [sessionId, previous] of bound) if (!next.has(sessionId)) changes.push({ sessionId, previous });
  bound = next;
  if (changes.length) for (const listener of changedListeners) listener(changes);
}

onAgentsSaved((agents) => { saves += 1; replace(project(agents)); });

/** The host says whose identities name this host's sessions (sign-in, sign-out, account switch). */
export async function setTaskNameOwner(ownerUserId: string | null, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  owner = ownerUserId;
  const before = saves;
  const agents = ownerUserId ? await listAgents(env) : [];
  // A roster save during the read already projected a newer roster for this owner.
  if (saves === before) replace(project(agents));
}

export function boundTaskName(sessionId: string): BoundTaskName | undefined {
  return bound.get(sessionId);
}

/** Whether some bound name on this host is still waiting to be published (cheap, synchronous). */
export function hasPendingTaskNames(): boolean {
  for (const entry of bound.values()) if (entry.pending) return true;
  return false;
}

/**
 * The one name of a session, decided by its state: bound to an identity → that identity's name;
 * otherwise its pending-bind record. A session without either is a defect at its creating entry.
 */
export function taskName(row: { id: string; config?: { agentDisplayName?: string } | null }): string {
  const bound = boundTaskName(row.id);
  if (bound) return bound.name;
  const name = row.config?.agentDisplayName?.trim();
  if (!name) throw new Error(`Session ${row.id} has no name`);
  return name;
}
