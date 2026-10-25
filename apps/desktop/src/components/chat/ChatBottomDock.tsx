import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { composerSlotClass, composerSlotInnerClass } from '@gugu/session-chat-ui/composer-layout'

/** 底部那一摞的实测高度,挂在它所在的那一栏上;消息流末尾(MessageList)和空态占位都按它让位。 */
const CHAT_DOCK_HEIGHT_VAR = '--chat-dock-h'

/**
 * The desktop composer uses the same slot frame as ACP tasks.
 *
 * 底部那一摞浮在消息流上,自己没有底(owner 10-25「应该是透明的」「用户感受到的这块应该是一个空地」):
 * 消息从运行条那一行、回复条后面滚过去,看得见;要底的只有 pill、回复条、输入框那几张卡自己。
 * 运行条那一行和两侧的空白不接指针,滚轮和点选落到后面的消息流上。
 * 它把自己的高度写进所在那一栏的 --chat-dock-h,消息流在最后一条后面让出同样高的一格,滚到底时最后一条落在运行条上面。
 * `above` 是运行条那一行:固定高度,里面有没有 pill 都不改变这一摞的高度,所以运行条出现、消失不改变布局。
 * reserve:没有消息流可让(空态、骨架)时,在列底占一格同高的位置,空态的内容不被盖住。
 * floating=false(手机):照旧按顺序排在消息流下面。
 */
export function ChatBottomDock({ floating, reserve, above, children }: { floating: boolean; reserve: boolean; above?: ReactNode; children: ReactNode }) {
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
  if (!floating) return <>{above}{children}</>
  return (
    <>
      {reserve && <div aria-hidden className="h-[var(--chat-dock-h,0px)] shrink-0" />}
      <div ref={ref} data-chat-bottom-dock="" className={`${composerSlotClass} absolute!`}>
        {above ? <div className={`${composerSlotInnerClass} pb-0! pointer-events-none!`}>{above}</div> : null}
        <div className={composerSlotInnerClass}>{children}</div>
      </div>
    </>
  )
}
