import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { composerSlotClass, composerSlotInnerClass, composerSlotInnerBottomClass } from '@gugu/session-chat-ui/composer-layout'

/** 底部那一摞的实测高度,挂在它所在的那一栏上;消息流末尾(MessageList)和空态占位都按它让位。 */
const CHAT_DOCK_HEIGHT_VAR = '--chat-dock-h'

/**
 * The desktop composer uses the same slot frame as ACP tasks. Only its absolute
 * anchoring and message-list height reservation belong to the IM host.
 *
 * 浮起来以后它不再占消息流的高度:它把自己的高度写进所在那一栏的 --chat-dock-h,消息流在最后一条后面让出同样高的一格,
 * 滚到底时最后一条落在运行条上面;它一变高(运行条出现、输入框长高),那一格跟着变,消息流在底部就照常贴底。
 * reserve:没有消息流可让(空态、骨架)时,在列底占一格同高的位置,空态的内容不被盖住。
 * floating=false(手机):照旧排在消息流下面。
 */
export function ChatBottomDock({ floating, reserve, children }: { floating: boolean; reserve: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = ref.current, column = el?.parentElement
    if (!floating || !el || !column) return
    const report = () => column.style.setProperty(CHAT_DOCK_HEIGHT_VAR, `${el.offsetHeight}px`)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => { observer.disconnect(); column.style.removeProperty(CHAT_DOCK_HEIGHT_VAR) }
  }, [floating])
  if (!floating) return <>{children}</>
  return (
    <>
      {reserve && <div aria-hidden className="h-[var(--chat-dock-h,0px)] shrink-0" />}
      <div ref={ref} data-chat-bottom-dock="" className={composerSlotClass} style={{ position: 'absolute' }}>
        <div className={`${composerSlotInnerClass} ${composerSlotInnerBottomClass}`}>{children}</div>
      </div>
    </>
  )
}
