import { useMemo, useState } from 'react'
import type { ChatCommands } from '@gugu/session-chat-ui'
import { filterTurnsForChat } from '@gugu/session-core/session-record/reply-process'
import { useSessionChatLayout } from '@renderer/lib/chat/use-session-chat-layout'
import { dismissSubagent } from '@renderer/features/sessions/view/subagent-dismissals'
import { SessionTranscriptView } from '../assistant-ui/session-transcript-view.aui'
import { assistantTimelineClient } from '../assistant/assistantTimelineClient'
import { useTimelineSession } from '@/mobile/agent-watch/use-timeline-session'
import { usePhoneBackgroundTasks } from '@/mobile/agent-watch/background-tasks'
import { useAgentDmSession } from '../../hooks/useAgentDmSession'
import { rendererLogger } from '../../lib/log'
import { AgentDmUnavailable } from './AgentDmUnavailable'

const log = rendererLogger('chat/agent-dm')

/**
 * 和 agent 的私聊:消息区画它那条会话的记录,只留这个私聊的那部分(`filterTurnsForChat`),
 * 用任务页同一个转录(conversation 布局:名字 → 过程行 → 气泡,后台那一行)。owner 10-27:三个入口
 * (任务页、项目页、手机)的 agent 私聊长一个样。解析不到会话就说是哪一种并给重试(AgentDmUnavailable),
 * ❌ 退回老的气泡列表。输入框不归这里:私聊照旧经咕咕投递发。
 */
export function AgentDmTranscript({ agentUserId, chatId, mobile = false }: { agentUserId: string; chatId: string; mobile?: boolean }) {
  const { session, retry } = useAgentDmSession(agentUserId)
  if (session.state !== 'ready') return <AgentDmUnavailable session={session} onRetry={retry} />
  return (
    <ReadyTranscript
      key={`${session.deviceId}/${session.sessionId}`}
      deviceId={session.deviceId}
      sessionId={session.sessionId}
      local={session.local}
      chatId={chatId}
      mobile={mobile}
      onRetry={retry}
    />
  )
}

function ReadyTranscript({ deviceId, sessionId, local, chatId, mobile, onRetry }: {
  deviceId: string; sessionId: string; local: boolean; chatId: string; mobile: boolean; onRetry: () => void
}) {
  // 本机读整份(❌ trim):私聊的回复就是 message_send 的 rawInput,截到 8 KB 的长回复会整条不见。
  const client = assistantTimelineClient(local, { trim: false })
  const read = useTimelineSession(client, 'desktop-agent-dm', deviceId, sessionId, true)
  const turns = useMemo(() => filterTurnsForChat(read.timeline.turns, chatId), [read.timeline.turns, chatId])
  const [dismissals, setDismissals] = useState(0)
  const background = usePhoneBackgroundTasks(deviceId, sessionId, read.timeline.turns, dismissals, true, client.fetchBackgroundTasks)
  const layout = useSessionChatLayout()
  const commands = useMemo<ChatCommands>(() => ({
    onStop: () => { void read.cancel() },
    ...(background.canStop && client.stopBackgroundTask ? {
      onStopBackgroundTask: ({ stopId }) => {
        client.stopBackgroundTask?.(deviceId, sessionId, stopId).catch((error: unknown) =>
          log.warn({ deviceId, sessionId, error: String(error) }, 'agent dm: background task did not stop'))
      },
    } : {}),
    onDismissBackgroundTask: ({ entryId }) => { dismissSubagent(sessionId, entryId); setDismissals((value) => value + 1) },
  }), [read, background.canStop, client, deviceId, sessionId])

  // 会话读不出来(记录不在了、那台机器连不上):同一个状态卡,❌ 一片空白。
  if (read.phase === 'error' && turns.length === 0) {
    return <AgentDmUnavailable session={{ state: 'failed', message: read.error ?? 'timeline unavailable' }} onRetry={() => { read.reload(); onRetry() }} />
  }
  return (
    <SessionTranscriptView
      uri={sessionId}
      turns={turns}
      layout={{ ...layout, agentConversation: true }}
      commands={commands}
      backgroundTasks={background}
      onReachStart={() => { void read.loadOlder() }}
      mobile={mobile}
      className="min-h-0 flex-1"
    />
  )
}
