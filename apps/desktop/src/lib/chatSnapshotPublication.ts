import type { Dispatch, SetStateAction } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { subscribeIdentities } from './chatMessageWindowPublication'
import type { IdentityDirectorySnapshot } from './identityDirectoryBridge'
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

// @@@local-first-frame — the list and its people paint from the local store as soon as it is read. Whatever the account
// initialization still waits on (a snapshot rebuild after an update, message alignment) runs behind this frame.
export function paintLocalChats(repository: AccountImRepository, list: {
  chatsRef: { current: ChatItem[] }
  projection: { seedFromCache(chats: readonly ChatItem[]): void }
  setChats: Dispatch<SetStateAction<ChatItem[]>>
  setChatsLoad: Dispatch<SetStateAction<'unread' | 'idle' | 'loading' | 'failed'>>
}): void {
  const cached = readCompleteCachedChats(repository)
  // Nothing local (a new device): the account read is what the list waits for, so it shows loading, not "no conversations".
  if (cached.length === 0) { if (list.chatsRef.current.length === 0) list.setChatsLoad((state) => state === 'unread' ? 'loading' : state); return }
  list.chatsRef.current = cached
  list.projection.seedFromCache(cached) // durable snapshot = 上一次会话的服务端投影 (#4314)
  list.setChats(cached)
}

/** openImRepository's `loaded` hook: local rows are readable, so unless this open was superseded, publish them. */
export function publishLocalFirstFrame(
  repository: AccountImRepository,
  isCurrent: () => boolean,
  onIdentities: (identities: IdentityDirectorySnapshot) => void,
  paint: (repository: AccountImRepository) => void,
): void {
  if (!isCurrent()) return
  subscribeIdentities(repository, onIdentities) // people (incl. my own avatar) resolve from local rows too
  paint(repository)
}

export function publishChatSnapshot(
  repository: AccountImRepository,
  chats: readonly ChatItem[] | (() => readonly ChatItem[]),
  identities: readonly unknown[],
  isConversationDeleted?: (id: string) => boolean,
): Promise<void> {
  return replaceChatRowsAndIdentities(repository, chats, identities, isConversationDeleted)
}
