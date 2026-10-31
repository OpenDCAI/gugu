import { agentsForOwner } from '@gugu/core/local/state/agentOwner'
import type { LocalAgentRecord } from '@gugu/core'
import type {
  EmdashAgentRegistration,
  LocalSessionFacts,
  LocalSessionPeer,
  LocalSessionPeerIdentity,
} from './emdash-agent-registry'

const SESSION_CACHE_KEY = 'emdash_session_id'
const DIRECT_CHAT_CACHE_KEY = 'sessionpage_direct_chat_id'

function cachedString(agent: Pick<LocalAgentRecord, 'cache'>, key: string): string {
  const value = agent.cache?.[key]
  return typeof value === 'string' ? value : ''
}

export type SessionpageRosterReader = () => Promise<readonly LocalAgentRecord[]>

export interface SessionpageSenderBinding {
  guguAgentUserId: string
  sessionId: string
  chatId: string | null
}

export interface SessionpageSenderBindingDeps {
  listRoster: SessionpageRosterReader
  ownerUserId: string | null
}

/** Resolve a sender identity from the durable roster, never from a delivery-owner snapshot. */
export async function resolveSessionpageSenderBinding(
  sessionId: string,
  deps: SessionpageSenderBindingDeps,
): Promise<SessionpageSenderBinding> {
  const roster = agentsForOwner(await deps.listRoster(), deps.ownerUserId)
  const candidates = roster.filter((agent) => cachedString(agent, SESSION_CACHE_KEY) === sessionId)
  const owned = candidates
  if (owned.length > 1) {
    throw new Error(
      `session-page identity lookup: session ${sessionId} maps to ${owned.length} canonical identities`,
    )
  }
  const agent = owned[0]
  if (!agent?.gugu_user_id) {
    throw new Error(`local direct sender ${sessionId} resolved to 0 identity binding(s); expected exactly one`)
  }
  return {
    guguAgentUserId: agent.gugu_user_id,
    sessionId,
    chatId: cachedString(agent, DIRECT_CHAT_CACHE_KEY) || null,
  }
}

export interface SessionpageSessionPeersDeps {
  sessionId?: string
  listRoster: SessionpageRosterReader
  ownerUserId: string | null
  lookupIdentities: (agentUserIds: readonly string[]) => Promise<readonly LocalSessionPeerIdentity[]>
  listSessionFacts: () => Promise<readonly LocalSessionFacts[]>
}

type SessionpageSessionPeerBinding = EmdashAgentRegistration & { engine: string }

/**
 * Resolve the session_peers directory from roster identity facts and the sidebar's session facts. ❌ 不读投递属主或
 * 运行时摘要推 live/offline(#6546):进程在不在不是 peer 的事实,发给任何一行都会按原会话唤醒它。
 */
export async function resolveSessionpageSessionPeers(
  deps: SessionpageSessionPeersDeps,
): Promise<(LocalSessionPeer & { engine: string })[]> {
  const roster = agentsForOwner(await deps.listRoster(), deps.ownerUserId)
  const bindings: SessionpageSessionPeerBinding[] = roster
    .filter((agent) => Boolean(agent.gugu_user_id))
    .map((agent) => ({
      guguAgentUserId: agent.gugu_user_id,
      sessionId: cachedString(agent, SESSION_CACHE_KEY),
      engine: agent.agent_type,
    }))
    .filter((binding) => Boolean(binding.sessionId) && (!deps.sessionId || binding.sessionId === deps.sessionId))
  if (!bindings.length) return []

  const [identities, sessions] = await Promise.all([
    deps.lookupIdentities(bindings.map((binding) => binding.guguAgentUserId)),
    deps.listSessionFacts(),
  ])
  const { resolveLocalSessionPeers } = await import('./emdash-agent-registry')
  const peers = resolveLocalSessionPeers(bindings, identities, sessions)
  return peers.map((peer) => {
    const binding = bindings.find((candidate) => candidate.guguAgentUserId === peer.identity.users.id)
    if (!binding?.engine) {
      throw new Error(`local peers roster lookup: no engine for mapped session ${peer.sessionId}`)
    }
    return { ...peer, engine: binding.engine }
  })
}
