import type { ChatItem } from '@gugu/core/shared/types/chat'
import { imSelectors, readChatRows, replaceChatRowsAndIdentities, type AccountImRepository } from './imRepository'

export function readCompleteCachedChats(repository: AccountImRepository): ChatItem[] {
  const chats = readChatRows(repository)
  const identities = imSelectors.identitiesById(repository.snapshot())
  return chats.every((chat) => chat.kind === 'group'
    ? (chat.member_user_ids ?? []).every((id) => !!identities[id])
    : !chat.peer_user_id || !!identities[chat.peer_user_id]) ? chats : []
}

export function publishChatSnapshot(
  repository: AccountImRepository,
  chats: ChatItem[],
  identities: readonly unknown[],
): Promise<void> {
  return replaceChatRowsAndIdentities(repository, chats, identities)
}
