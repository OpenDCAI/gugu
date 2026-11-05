import type { ChatItem } from '@gugu/core/shared/types/chat'
import { imSelectors, readChatRows, replaceChatRowsAndIdentities, type AccountImRepository } from './imRepository'
import { rendererLogger } from './log'

const publicationLog = rendererLogger('im/first-frame')

/** Cached chats whose people are all known locally. A chat missing one is left out of the first frame (the account
 * read brings it back); it never takes the other rows with it. */
export function readCompleteCachedChats(repository: AccountImRepository): ChatItem[] {
  const identities = imSelectors.identitiesById(repository.snapshot())
  const incomplete: string[] = []
  const chats = readChatRows(repository).filter((chat) => (chat.kind === 'group'
    ? (chat.member_user_ids ?? []).every((id) => !!identities[id])
    : !chat.peer_user_id || !!identities[chat.peer_user_id]) || (incomplete.push(chat.id), false))
  if (incomplete.length > 0) publicationLog.error({ count: incomplete.length, chatIds: incomplete.slice(0, 20) }, 'cached chats reference people missing locally; left out of the first frame')
  return chats
}

export function publishChatSnapshot(
  repository: AccountImRepository,
  chats: ChatItem[],
  identities: readonly unknown[],
  isConversationDeleted?: (id: string) => boolean,
  readChats?: () => ChatItem[],
): Promise<void> {
  return replaceChatRowsAndIdentities(repository, chats, identities, isConversationDeleted, readChats)
}
