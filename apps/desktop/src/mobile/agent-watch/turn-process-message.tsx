import { useAuiState } from '@assistant-ui/react'
import { createContext, useContext, useEffect, useState, type FC, type ReactNode } from 'react'
import { turnProcessExpanded, turnProcessLabel, type TurnProcessHeader } from '@gugu/session-chat-ui/turn-fold'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { AssistantMessage } from '@/components/assistant-ui/thread.aui'
import { useAuiCopy } from '@/components/assistant-ui/copy'
import { ToolGroupContent, ToolGroupRoot, ToolGroupTrigger } from '@/components/assistant-ui/tool-group.aui'
import type { TurnProcessMetadata } from './thread-messages'
import { LiveTail } from './live-tail'

/**
 * 每颗折叠头「有没有被点过」,按折叠 id 记(同桌面的 ViewState)。
 * ⚠️ ❌ 记在行组件自己的 state 里:线程按位置复用行(见 thread.aui 的 ThreadMessages),同一行可能换成另一条消息,
 * 开合状态就跟着串到别人头上。
 */
const TurnProcessToggles = createContext<{ toggled: Readonly<Record<string, boolean>>; toggle: (id: string) => void }>({
  toggled: {},
  toggle: () => {},
})

export function TurnProcessToggleProvider({ children }: { children: ReactNode }) {
  const [toggled, setToggled] = useState<Readonly<Record<string, boolean>>>({})
  const toggle = (id: string) => setToggled((prev) => ({ ...prev, [id]: !prev[id] }))
  return <TurnProcessToggles.Provider value={{ toggled, toggle }}>{children}</TurnProcessToggles.Provider>
}

/** 跑着的头每秒数一次;落定后不再数。 */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

/**
 * 一轮的过程(thread-messages 把它单独排成一条消息)收在桌面同款的时间头下:跑着「已处理 Ns」、
 * 摊开;跑完「用时 Ns ›」、收起,点开还原。头上写什么与何时算跑着,都是桌面那一份判断(turn-fold)。
 */
function TurnProcessFold({ header }: { header: TurnProcessHeader }) {
  const { toggled, toggle } = useContext(TurnProcessToggles)
  const expanded = turnProcessExpanded(header.live, toggled[header.id] === true)
  const now = useNow(header.live && header.startedAt !== undefined)
  // 人点过这颗头才算「打开」:内容的入场(官方 ToolGroupContent 给子元素的淡入 + 上滑)只给这一下,见 agent-watch.css。
  const opened = header.id in toggled
  return (
    <div
      data-slot="turn-process"
      data-live={header.live ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
      data-opened={opened ? 'true' : undefined}
      className="px-2"
    >
      <ToolGroupRoot variant="ghost" open={expanded} onOpenChange={() => toggle(header.id)}>
        <ToolGroupTrigger count={0} label={turnProcessLabel(header, now, translateSessionMessage)} active={header.live} />
        {/* 过程没有自己的复制 / 更多(同桌面),见 agent-watch.css。 */}
        <ToolGroupContent>
          <AssistantMessage />
        </ToolGroupContent>
      </ToolGroupRoot>
    </div>
  )
}


export const TurnProcessMessage: FC = () => {
  const header = useAuiState((s) => (s.message.metadata.custom as Partial<TurnProcessMetadata> | undefined)?.turnProcess)
  const id = useAuiState((s) => s.message.id)
  const isLast = useAuiState((s) => s.message.isLast)
  const live = useContext(LiveTail) === id
  const c = useAuiCopy()
  if (header) return <TurnProcessFold header={header} />
  // data-last:只有最后一条留动作栏那一格(见 agent-watch.css @@@aw-footer);data-live:那一格换成「正在回」的点。
  return (
    <div data-slot="assistant-turn" data-last={isLast ? 'true' : undefined} data-live={live ? 'true' : undefined}>
      <AssistantMessage />
      {live ? <span className="gg-aw-live-tail-dot" aria-label={c.running}>●</span> : null}
    </div>
  )
}
