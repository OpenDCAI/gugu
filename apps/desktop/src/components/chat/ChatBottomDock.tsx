import { useLayoutEffect, useRef, type ReactNode } from 'react'

/** 底部那一摞的实测高度,挂在它所在的那一栏上;消息流末尾(MessageList)和空态占位都按它让位。 */
const CHAT_DOCK_HEIGHT_VAR = '--chat-dock-h'

/**
 * 会话底部那一摞(运行条、回合失败条、输入框 / 多选条)浮在消息流上,垫一层半透明底色:往上滑时消息从运行条和输入框四周
 * 隐约透出来,运行条和下面的输入区是同一层(owner 2026-10-23「类似 telegram 的那种半透明遮蔽」「状态 bar…和下面的输入框部分
 * 衔接自然」,❌ 一整条实色白底)。与会话页输入框槽同一层底色(chat-root.css.ts composerSlotInnerBottomClass)。
 * 只是带 alpha 的底色,❌ backdrop-filter(玻璃拟态已退役;mac 上一块就让 GPU 进程那份驱动内存清不掉)。
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
      <div ref={ref} data-chat-bottom-dock="" className="absolute inset-x-0 bottom-0 z-[1] bg-[color-mix(in_srgb,var(--bg-primary)_82%,transparent)]">
        {children}
      </div>
    </>
  )
}
