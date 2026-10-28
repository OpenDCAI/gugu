import type { ChatItem } from '@gugu/core/shared/types/chat'
import { imSelectors, readChatRows, replaceChatRowsAndIdentities, type AccountImRepository } from './imRepository'

export function readCompleteCachedChats(repository: AccountImRepository): ChatItem[] {
  const chats = readChatRows(repository)
  const identities = imSelectors.identitiesById(repository.snapshot())
  return chats.every((chat) => (chat.kind === 'group'
    ? (chat.member_user_ids ?? []).every((id) => !!identities[id])
    : !chat.peer_user_id || !!identities[chat.peer_user_id])
    // 旧版客户端写下的未读定位没有 addressed_count(gugu-supabase#73 之前):拿它当「上一版」去比,
    // 话题的「叫到你」会从 0 跳到真值,升级后头一次启动每个这样的话题各弹一条假通知。整份作废,冷启照常拉。
    && (!chat.unread_locator || typeof chat.unread_locator.addressed_count === 'number')) ? chats : []
}

export function publishChatSnapshot(
  repository: AccountImRepository,
  chats: ChatItem[],
  identities: readonly unknown[],
): Promise<void> {
  return replaceChatRowsAndIdentities(repository, chats, identities)
}
