import type { MutableRefObject } from 'react'
import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
import { chatService } from '../lib/chat'
import { createAccountRevisionCoordinator, type AccountRevisionCoordinator } from '../lib/accountRevisionCoordinator'
import { createSupabaseAccountRevisionSource } from '../lib/supabaseAccountRevisionSource'
import { readMessageWindow, type AccountImRepository } from '../lib/imRepository'
import type { NotificationSettings } from '../lib/notificationSettings'
import { isChatOnScreen } from '../lib/onScreenChat'
import type { RefreshChatsOptions } from './chatContext'
import { notifyForIngestedMessage } from './chatListProjection'

type MessageNotification = (repository: AccountImRepository, message: MessageItem) => Promise<void>
type AccountScope = { disposed: boolean }

export async function getChatRevisionCoordinator(ports: {
  userId: string | null
  scope: AccountScope
  getRepository: () => Promise<AccountImRepository>
  coordinatorRef: MutableRefObject<AccountRevisionCoordinator | null>
  promiseRef: MutableRefObject<Promise<AccountRevisionCoordinator> | null>
  notificationRef: MutableRefObject<MessageNotification>
}): Promise<AccountRevisionCoordinator> {
  const { userId, scope, getRepository, coordinatorRef, promiseRef, notificationRef } = ports
  if (coordinatorRef.current) return coordinatorRef.current
  if (promiseRef.current) return promiseRef.current
  const promise = getRepository().then((repository) => {
    if (!userId || scope.disposed) throw new Error('Account revision scope disposed before start')
    const coordinator = createAccountRevisionCoordinator(
      userId,
      repository,
      createSupabaseAccountRevisionSource(),
      {
        recover: messageId => chatService.getMessageById(messageId, userId),
        notify: message => notificationRef.current(repository, message),
      },
    )
    coordinatorRef.current = coordinator
    coordinator.start()
    return coordinator
  })
  promiseRef.current = promise
  try {
    return await promise
  } finally {
    if (promiseRef.current === promise) promiseRef.current = null
  }
}

export function createChatMessageNotification(ports: {
  userId: string | null
  scope: AccountScope
  chatsRef: MutableRefObject<ChatItem[]>
  loadChats: (options?: RefreshChatsOptions) => Promise<void>
  notificationSettings: Pick<NotificationSettings, 'chatMessages' | 'sound'>
}): MessageNotification {
  const { userId, scope, chatsRef, loadChats, notificationSettings } = ports
  return async (repository, message) => {
    if (scope.disposed || repository.accountId !== userId) return
    let chat = chatsRef.current.find(row => row.id === message.chat_id)
      ?? repository.snapshot().chat.find(row => row.id === message.chat_id)?.value
    if (!chat) {
      await loadChats({ throwOnError: true })
      chat = repository.snapshot().chat.find(row => row.id === message.chat_id)?.value
    }
    if (!chat || scope.disposed || repository.accountId !== userId) return
    await notifyForIngestedMessage(userId, chat, message, { onScreen: isChatOnScreen,
      notificationsEnabled: notificationSettings.chatMessages, soundEnabled: notificationSettings.sound })
  }
}

export function chatMessageRecoverySeq(
  repository: AccountImRepository | null,
  chatId: string,
  maxSeqOf: (chatId: string) => number,
): number {
  // A sparse event cache is paintable, not a verified pagination cursor.
  // Reuse the bounded delta and existing full-page degrade from the start.
  const sparse = repository && readMessageWindow(repository, chatId)?.sparse
  return sparse ? 0 : maxSeqOf(chatId)
}
