import { groupDisplayName } from '@gugu/core/shared/ui/chatModels'
import { useChatStore } from '../store/chatContext'

/** Lookup/invitation records carry shared names; resolve their live private override from the same projection. */
export function useGroupDisplayName(group: { id?: string; public_id?: number | null; name?: string | null; alias?: string | null } | null): string {
  const { chats } = useChatStore('chats')
  const projected = group && chats.find((chat) => chat.kind === 'group'
    && (group.id ? chat.id === group.id : group.public_id != null && chat.public_id === group.public_id))
  return groupDisplayName({ ...group, alias: projected ? projected.alias : group?.alias })
}
