import type { ReactNode } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { MessageSenderTarget } from '@gugu/session-chat-ui'
import { MessageSenderContext } from './MessageSenderContext'
import { useMobileShell } from '@/hooks/useMobileShell'

export function MessageSenderProvider({ message, group, children }: { message: Pick<MessageItem, 'id' | 'chat_id' | 'sender_user_id'>; group: boolean; children: ReactNode }) {
  const mobile = useMobileShell()
  const target: MessageSenderTarget | null = group && mobile ? { kind: 'chat', chatId: message.chat_id, messageId: message.id }
    : message.sender_user_id ? { kind: 'sender', userId: message.sender_user_id, ...(group ? { sourceChatId: message.chat_id } : {}) } : null
  return <MessageSenderContext.Provider value={target}>{children}</MessageSenderContext.Provider>
}
