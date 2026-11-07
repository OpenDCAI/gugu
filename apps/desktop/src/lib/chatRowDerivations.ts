import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { IdentityDirectorySnapshot } from './identityDirectoryBridge'
import { replaceEqualDeep } from '@tanstack/react-query'
import { memoizeByReference } from './memoizeByReference'

/** Activity can reorder rows without changing any membership. Only rebuild aggregate strings/ids when parts change. */
export function createChatMembershipProjection() {
  const partsOf = memoizeByReference((chat: ChatItem, directory: IdentityDirectorySnapshot) => {
    const ids = chat.member_user_ids ?? [], peer = chat.peer_user_id
    return { group: chat.kind === 'group' ? `${chat.id}:${[...ids].sort().join(',')}` : null,
      peer: (chat.kind === 'dm' || chat.kind === 'ai') && peer && directory[peer]?.type === 'agent' ? peer : null,
      agents: ids.filter(id => directory[id]?.type === 'agent') }
  })
  let held: Record<string, ReturnType<typeof partsOf>> = {}
  let result = { key: '', agentIds: [] as string[], parts: new Map(Object.entries(held)) }
  return (chats: readonly ChatItem[], directory: IdentityDirectorySnapshot) => {
    const next = replaceEqualDeep(held, Object.fromEntries(chats.map(chat => [chat.id, partsOf(chat, directory)])))
    if (next !== held) {
      held = next
      const parts = Object.values(next)
      result = { key: parts.flatMap(part => part.group === null ? [] : [part.group]).sort().join('|'),
        agentIds: parts.flatMap(part => part.peer ? [part.peer, ...part.agents] : part.agents).sort(), parts: new Map(Object.entries(next)) }
    }
    return result
  }
}
