import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { IdentityDirectorySnapshot } from './identityDirectoryBridge'
import { replaceEqualDeep } from '@tanstack/react-query'

/** Rows are immutable publications. A moved row keeps its cached derivations. */
export function memoizeChatRow<T>(derive: (chat: ChatItem) => T): (chat: ChatItem) => T {
  const values = new WeakMap<ChatItem, T>()
  return chat => {
    if (values.has(chat)) return values.get(chat)!
    const value = derive(chat)
    values.set(chat, value)
    return value
  }
}

const EMPTY_MEMBERS: readonly string[] = []
type MembershipParts = { group: string | null; peer: string | null; agents: readonly string[] }

/** Activity can reorder rows without changing any membership. Only rebuild aggregate strings/ids when parts change. */
export function createChatMembershipProjection() {
  const rows = new WeakMap<ChatItem, { directory: IdentityDirectorySnapshot; value: MembershipParts }>()
  let held = new Map<string, MembershipParts>()
  let result = { key: '', agentIds: [] as string[], parts: held }
  return (chats: readonly ChatItem[], directory: IdentityDirectorySnapshot) => {
    const next = new Map<string, MembershipParts>()
    let changed = chats.length !== held.size
    for (const chat of chats) {
      let cached = rows.get(chat)
      if (!cached || cached.directory !== directory) {
        const ids = chat.member_user_ids ?? EMPTY_MEMBERS, peer = chat.peer_user_id
        cached = { directory, value: { group: chat.kind === 'group' ? `${chat.id}:${[...ids].sort().join(',')}` : null,
          peer: (chat.kind === 'dm' || chat.kind === 'ai') && peer && directory[peer]?.type === 'agent' ? peer : null,
          agents: ids.filter(id => directory[id]?.type === 'agent') } }
        rows.set(chat, cached)
      }
      const part = cached.value
      const previous = held.get(chat.id)
      const same = previous && (previous === part || previous.group === part.group && previous.peer === part.peer
        && replaceEqualDeep(previous.agents, part.agents) === previous.agents)
      next.set(chat.id, same ? previous : part)
      if (same) cached.value = previous
      if (!same) changed = true
    }
    held = next
    if (changed) {
      const parts = [...next.values()]
      result = { key: parts.flatMap(part => part.group === null ? [] : [part.group]).sort().join('|'),
        agentIds: parts.flatMap(part => part.peer ? [part.peer, ...part.agents] : part.agents).sort(), parts: next }
    }
    return result
  }
}
