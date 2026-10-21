import { makeAssistantDataUI } from '@assistant-ui/react'
import { useContext, useMemo, type ReactElement } from 'react'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { SharedTurnTranscript, useSharedChatRuntime } from '@/components/assistant-ui/shared-transcript.aui'
import { OpenedOutputHandlersContext } from './opened-output-handlers'
import { OUTPUTS_DATA_PART, type OpenedOutputsData } from './thread-messages'

/**
 * 一轮交出来的文件 / 网页(#7193),画成桌面会话页同一张附件卡:把记下它们的那几条调用交给桌面那套转录,
 * 卡怎么认、怎么写、长什么样都是那一份(session-chat-ui 的 opened-output 行)—— ❌ 手机上另写一份。
 * 点开走这条会话自己的口子(`OpenedOutputHandlersContext`)。
 */
function OpenedOutputsPart({ data }: { data: OpenedOutputsData }): ReactElement {
  const runtime = useSharedChatRuntime()
  const handlers = useContext(OpenedOutputHandlersContext)
  const turn = useMemo<TranscriptTurn>(
    () => ({ id: `mobile-outputs:${data.turnId}`, seq: 0, initiator: 'agent', items: data.items }),
    [data],
  )
  return (
    // -mx-4 = 抵掉转录给每一行的左右缩进(ROW_INSET_X = 16,有单测钉着),卡片与上面那段正文左右对齐。
    <div data-testid="mobile-opened-outputs" className="-mx-4 min-w-0">
      {runtime ? (
        <SharedTurnTranscript
          runtime={runtime}
          uri={`mobile-outputs:${data.turnId}`}
          turn={turn}
          {...(handlers ? { commands: handlers } : {})}
        />
      ) : null}
    </div>
  )
}

export const OpenedOutputsDataUI = makeAssistantDataUI<OpenedOutputsData>({ name: OUTPUTS_DATA_PART, render: OpenedOutputsPart })
