import { useEffect, useMemo } from 'react'
import { useTimelineSession } from '@/mobile/agent-watch/use-timeline-session'
import type { AgentReplyPending } from '@/lib/agentReplyPending'
import { AssistantTyping } from './AssistantTyping'
import { assistantReplyActivity } from './assistantReplyActivity'
import { assistantTimelineClient } from './assistantTimelineClient'
import { rendererLogger } from '@/lib/log'

const log = rendererLogger('assistant/reply-progress')

/** Mounted with an endpoint key: switching agents/devices never shows the previous timeline for a frame. */
export function AssistantTypingLive({ deviceId, sessionId, local, messageId, pending, name }: {
  deviceId: string; sessionId: string; local: boolean; messageId: string
  pending: Exclude<AgentReplyPending, null>; name: string
}) {
  const read = useTimelineSession(assistantTimelineClient(local), 'assistant-progress', deviceId, sessionId, true)
  const source = read.timeline.liveReply?.sourceMessageId ?? null
  const phase = read.timeline.liveReply?.activity.phase ?? null
  useEffect(() => {
    const detail = { deviceId, sessionId, messageId, phase: read.phase, link: read.link, source, activity: phase, error: read.error }
    if (read.error) log.warn(detail, 'reply progress unavailable')
    else log.debug(detail, 'reply progress changed')
  }, [deviceId, sessionId, messageId, read.phase, read.link, read.error, source, phase])
  const activity = useMemo(() => read.phase === 'ready' && read.link === 'ok'
    ? assistantReplyActivity(read.timeline.liveReply, messageId) : null,
  [read.phase, read.link, read.timeline.liveReply, messageId])
  return <AssistantTyping pending={pending} name={name} activity={activity} />
}
