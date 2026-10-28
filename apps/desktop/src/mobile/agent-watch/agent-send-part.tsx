import { makeAssistantDataUI } from '@assistant-ui/react'
import type { ReactElement } from 'react'
import { agentSendLabel } from '@gugu/session-chat-ui/agent-send'
import { Markdown } from '@/components/markdown/Markdown'
import { chatDisplayName } from '@/session/renderer/lib/chat/chat-name'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { AGENT_SEND_DATA_PART, type AgentSendData } from './thread-messages'

/**
 * agent 经 message_send / session_message 说的一段话:和它自己的回复同一种正文(MarkdownText 那一读法),下面一行
 * 说发到了哪里 —— 去向的写法与桌面 agent-send 行同一份(`agentSendLabel`),群名与桌面同一个来源(`chatDisplayName`)。
 */
function AgentSendPart({ data }: { data: AgentSendData }): ReactElement {
  const where = agentSendLabel(data.send.to, translateSessionMessage, chatDisplayName)
  return (
    <div data-testid="mobile-agent-send" data-item-id={data.id} className="min-w-0">
      <Markdown trust="chat" hardBreaks content={data.send.text} />
      <div className="mt-1 truncate text-xs text-muted-foreground">
        {data.sending ? `${where} · ${translateSessionMessage('transcript.agentSending')}` : where}
      </div>
    </div>
  )
}

export const AgentSendDataUI = makeAssistantDataUI<AgentSendData>({ name: AGENT_SEND_DATA_PART, render: AgentSendPart })
