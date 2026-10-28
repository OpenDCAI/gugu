import { createContext, useContext } from 'react'
import type { MessageSenderTarget } from '@gugu/session-chat-ui'

export const MessageSenderContext = createContext<MessageSenderTarget | null>(null)
export const useMessageSenderTarget = () => useContext(MessageSenderContext)
