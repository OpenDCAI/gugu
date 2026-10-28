import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { ChatCommands, ChatContext, ChatLayout, ChatState } from '@gugu/session-chat-ui'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { ChatTranscript, loadChatUi } from '@renderer/lib/chat/chat-transcript'
import { createSessionChatContext } from '@renderer/lib/chat/shared-chat-context'
import { planHistorySync, splitActiveTurn } from './transcript-sync'

export type SessionBackgroundTasks = Parameters<ChatState['session']['setBackgroundTasks']>[0]

const NO_BACKGROUND_TASKS: SessionBackgroundTasks = { commands: [], subagents: [] }

type Model = { uri: string; context: ChatContext; state: ChatState }

/**
 * 一整条会话的转录(session-chat-ui,任务页同一个组件),从 React 页面里画。数据是一份完整的时间线
 * (`TranscriptTurn[]`,比如 `useTimelineSession` 读回来的,或再按私聊筛过的):最后一轮没收尾就是正在进行的那一轮。
 *
 * 它自己有一个 ChatContext:layout 设在 context 上,❌ 用 `getSharedChatContext()` —— 那样设了
 * `agentConversation` 会把同一个窗口里别的转录(投递卡、思考行)一起改掉。
 *
 * `mobile`:手机壳里画(窄屏、底部安全区)。点按、展开这些交互由转录自己按视口处理。
 */
export function SessionTranscriptView({
  uri,
  turns,
  layout,
  commands,
  backgroundTasks,
  onReachStart,
  mobile = false,
  className,
  style,
}: {
  /** 这条会话的身份(换会话 = 换一份 ChatState)。 */
  uri: string
  turns: readonly TranscriptTurn[]
  layout?: ChatLayout
  commands?: ChatCommands
  /** 此刻还在跑的后台任务(宿主算好的两份名单);不给 = 没有。 */
  backgroundTasks?: SessionBackgroundTasks
  /** 滚到顶了:往前翻更早的轮。 */
  onReachStart?: () => void
  mobile?: boolean
  className?: string
  style?: CSSProperties
}): ReactElement | null {
  const [model, setModel] = useState<Model | null>(null)
  const written = useRef<readonly TranscriptTurn[]>([])

  useEffect(() => {
    let live = true
    let created: Model | null = null
    void loadChatUi().then(({ createChatState }) => {
      if (!live) return
      const context = createSessionChatContext()
      created = { uri, context, state: createChatState(context, { uri }) }
      written.current = []
      setModel(created)
    })
    return () => {
      live = false
      if (created) {
        created.state.dispose()
        created.context.dispose()
      }
      setModel(null)
    }
  }, [uri])

  // 画之前写进去:❌ 先画一帧空转录、下一帧才长出正文。
  useLayoutEffect(() => {
    if (!model) return
    const { settled, active } = splitActiveTurn(turns)
    const plan = planHistorySync(written.current, settled)
    const { history, activeTurn } = model.state.transcript
    if (plan.op === 'seed') history.seed(plan.turns)
    else if (plan.op === 'append') history.append(plan.turns)
    else if (plan.op === 'prepend') history.prepend(plan.turns)
    written.current = settled
    // seed 会清掉进行中的那一轮,所以每次都重写它。
    activeTurn.set(active, active ? 'generating' : undefined)
  }, [model, turns])

  useEffect(() => {
    model?.state.session.setBackgroundTasks(backgroundTasks ?? NO_BACKGROUND_TASKS)
  }, [model, backgroundTasks])

  if (!model) return null
  return (
    <ChatTranscript
      context={model.context}
      state={model.state}
      commands={commands}
      composer="none"
      stickToBottom
      pinUserMessages={false}
      layout={layout}
      onReachStart={onReachStart}
      className={[mobile ? 'gg-session-transcript gg-session-transcript--mobile' : 'gg-session-transcript', className].filter(Boolean).join(' ')}
      style={style}
    />
  )
}
