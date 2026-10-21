import { useEffect, useMemo, type ReactNode } from 'react'
import { replyProcesses } from '@gugu/session-core/session-record/reply-process'
import { useTimelineSession } from '@/mobile/agent-watch/use-timeline-session'
import { useSessionpageAgentProjection } from '@/hooks/useSessionpageAgentProjection'
import { useAgentSessionRow } from '@/mobile/agent-watch/useAgentSessionRow'
import { useContactsStore } from '@/store/contactsContext'
import { useDevicesStore } from '@/store/devicesContext'
import { assistantTimelineClient } from './assistantTimelineClient'

import { rendererLogger } from '@/lib/log'
import { ProgressContext } from './assistantConversationProgressContext'

const log = rendererLogger('assistant/reply-progress')

function TimelineProgress({ deviceId, sessionId, local, chatId, children }: {
  deviceId: string; sessionId: string; local: boolean; chatId: string; children: ReactNode
}) {
  const read = useTimelineSession(assistantTimelineClient(local), 'assistant-progress', deviceId, sessionId, true)
  useEffect(() => { if (read.error) log.warn({ deviceId, sessionId, error: read.error }, 'reply progress unavailable') }, [deviceId, sessionId, read.error])
  const replies = useMemo(() => replyProcesses(read.timeline.turns, chatId), [read.timeline.turns, chatId])
  const value = useMemo(() => ({ live: read.phase === 'ready' && read.link === 'ok' ? read.timeline.liveReply ?? null : null, replies,
    retryMissingRecord: read.errorCode === 'record_not_found' ? read.reload : null }),
    [read.phase, read.link, read.timeline.liveReply, replies, read.errorCode, read.reload])
  useEffect(() => {
    log.debug({ deviceId, sessionId, phase: read.phase, link: read.link, source: value.live?.sourceMessageId, activity: value.live?.activity.phase }, 'reply progress state')
  }, [deviceId, sessionId, read.phase, read.link, value.live?.sourceMessageId, value.live?.activity.phase])
  return <ProgressContext.Provider value={value}>{children}</ProgressContext.Provider>
}

/** One host subscription for this assistant's private conversation, including historical reply evidence. */
export function AssistantConversationProgress({ assistantId, chatId, visible, children }: {
  assistantId: string | null; chatId: string | null; visible: boolean; children: ReactNode
}) {
  const { contacts } = useContactsStore()
  const { devices } = useDevicesStore()
  const deviceId = contacts.find(contact => contact.id === assistantId)?.device_id ?? null
  const local = devices.some(device => device.device_id === deviceId && device.is_current_device)
  const enabled = visible && Boolean(chatId)
  const projection = useSessionpageAgentProjection(enabled && local ? assistantId : null)
  const row = useAgentSessionRow(enabled && !local ? assistantId : null)
  const endpoint = local ? deviceId : row?.deviceId
  const sessionId = local ? projection.context?.sessionId : row?.session.conversationId
  return enabled && endpoint && sessionId && chatId
    ? <TimelineProgress key={`${assistantId}/${chatId}/${endpoint}/${sessionId}`} deviceId={endpoint} sessionId={sessionId} local={local} chatId={chatId}>{children}</TimelineProgress>
    : <ProgressContext.Provider value={null}>{children}</ProgressContext.Provider>
}
