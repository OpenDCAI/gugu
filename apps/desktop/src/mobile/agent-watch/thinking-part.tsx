import { makeAssistantDataUI } from '@assistant-ui/react'
import { useMemo, type ReactElement } from 'react'
import type { TranscriptThinking, TranscriptTurn } from '@gugu/session-core/acp/client'
import { SharedTurnTranscript, useSharedChatRuntime } from '@/components/assistant-ui/shared-transcript.aui'
import { THINKING_DATA_PART } from './thread-messages'

/**
 * 一段思考,画成桌面会话页的那一行:想着的时候「思考中 Ns」+ 实时预览窗,想完「思考了 Ns · 要旨」、
 * 点开看全文。和桌面同一份组件(session-chat-ui 的 thinking 行),❌ 手机上另写一份。
 */
function ThinkingPart({ data }: { data: TranscriptThinking }): ReactElement {
  const runtime = useSharedChatRuntime()
  const turn = useMemo<TranscriptTurn>(
    () => ({ id: `mobile-thinking:${data.id}`, seq: 0, initiator: 'agent', items: [data] }),
    [data],
  )
  return (
    <div data-testid="mobile-thinking" data-status={data.status} className="w-full min-w-0">
      {runtime ? <SharedTurnTranscript runtime={runtime} uri={`mobile-thinking:${data.id}`} turn={turn} /> : null}
    </div>
  )
}

export const ThinkingDataUI = makeAssistantDataUI<TranscriptThinking>({ name: THINKING_DATA_PART, render: ThinkingPart })
