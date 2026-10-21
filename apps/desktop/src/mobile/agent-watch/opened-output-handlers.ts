import { createContext } from 'react'
import type { ChatCommands } from '@gugu/session-chat-ui'

/** 手机上这条会话的附件卡怎么开、哪张开不了(#7193;AgentThread 按所在机器与会话给,见 opened-output-opener)。 */
export type OpenedOutputHandlers = Pick<ChatCommands, 'onOpenOutput' | 'outputUnavailable' | 'outputOpenMode' | 'onOutputMenu'>

export const OpenedOutputHandlersContext = createContext<OpenedOutputHandlers | null>(null)
