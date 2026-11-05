import { clashSuffixes } from '@gugu/core/shared/clashSuffix'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'

type Identity = { type?: 'human' | 'agent'; display_name: string; nameSerial?: number | null }
type Identities = Readonly<Record<string, Identity>>
type Roster = Pick<GroupCollabSnapshot, 'humans' | 'agents'>
const cache = new WeakMap<Roster | readonly string[], WeakMap<Identities, ReadonlyMap<string, string>>>()
export const NO_CLASH_NAMES: ReadonlyMap<string, string> = new Map()

export function chatClashNames(members: readonly { id: string; type: 'human' | 'agent' }[], identities: Identities): ReadonlyMap<string, string> {
  const rows = members.flatMap(member => identities[member.id] ? [{ ...member, displayName: identities[member.id].display_name, nameSerial: identities[member.id].nameSerial ?? null }] : [])
  return new Map([...clashSuffixes(rows)].map(([id, suffix]) => [id, `${identities[id].display_name} ${suffix}`]))
}

/** Share one projection across the conversation, drawer and composer for this snapshot. */
function cachedNames(key: Roster | readonly string[], members: () => readonly { id: string; type: 'human' | 'agent' }[], identities: Identities) {
  let byIdentity = cache.get(key)
  if (!byIdentity) { byIdentity = new WeakMap(); cache.set(key, byIdentity) }
  let names = byIdentity.get(identities)
  if (!names) {
    names = chatClashNames(members(), identities)
    byIdentity.set(identities, names)
  }
  return names
}

export function groupClashNames(snapshot: Roster, identities: Identities): ReadonlyMap<string, string> {
  return cachedNames(snapshot, () => [...snapshot.humans, ...snapshot.agents.filter(agent => agent.account_status !== 'removed')], identities)
}

export function topicClashNames(ids: readonly string[], identities: Identities): ReadonlyMap<string, string> {
  return cachedNames(ids, () => ids.flatMap(id => identities[id]?.type ? [{ id, type: identities[id].type! }] : []), identities)
}
