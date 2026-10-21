import { createContext, useContext } from 'react'
import type { SessionLiveReply } from '@gugu/session-core/session-record/contract'
import type { ReplyProcess } from '@gugu/session-core/session-record/reply-process'

type Progress = { live: SessionLiveReply | null; replies: ReadonlyMap<string, ReplyProcess>; retryMissingRecord?: (() => void) | null }
export const ProgressContext = createContext<Progress | null>(null)
export const useAssistantConversationProgress = () => useContext(ProgressContext)
