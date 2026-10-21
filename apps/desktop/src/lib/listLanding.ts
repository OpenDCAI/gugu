import { useEffect, useState, type RefObject } from 'react'
import type { ListLanding } from './flowList'

// 不传落点时的缺省:最新一条。getMessages 返回的是时间正序 ⇒ 不写这一行,打开一条聊过几十句的线会停在最早那一句。
export const OPEN_AT_LATEST: ListLanding = { index: 'LAST', align: 'end' }

/**
 * 这次挂载列表落在哪(#6595):有读到一半的位置 ⇒ 直接落在那一行(锚点 + 离视口顶的偏移),在第一次绘制之前放好;
 * 没有 ⇒ 最新一条;锚点还没载进窗口 ⇒ null(先按最新处放但整块藏着;锚点那段换进窗口时整列表重挂,那次就落在锚点)。
 */
export function restoreLanding(saved: { messageId: string; offset: number } | null, messageIds: ReadonlyArray<string>): ListLanding | null {
  if (!saved) return OPEN_AT_LATEST
  const index = messageIds.indexOf(saved.messageId)
  return index < 0 ? null : { index, align: 'start', offset: -saved.offset }
}

/**
 * 消息行此刻相对滚动视口在哪。按真实几何判:列表渲染的行远多于视口里的(整窗按文档流排),
 * 渲染了不等于看得见。行没渲染出来就和已渲染的第一行比序号(aria-posinset = 数据下标 + 1)。
 */
export function rowPlacement(scroller: HTMLElement, messageId: string, index: number): 'above' | 'visible' | 'below' {
  const rendered = Array.from(scroller.querySelectorAll<HTMLElement>('[data-msg-id]'))
  const row = rendered.find((element) => element.dataset.msgId === messageId)
  if (!row) return index < 0 || (rendered.length > 0 && index + 1 < Number(rendered[0].getAttribute('aria-posinset'))) ? 'above' : 'below'
  const view = scroller.getBoundingClientRect()
  const rect = row.getBoundingClientRect()
  return rect.bottom <= view.top ? 'above' : rect.top >= view.bottom ? 'below' : 'visible'
}

/**
 * 盯住一行:它在视口上方时为 true;滚到看得见过一次之后恒为 false(#6530 微信式「↑ N 条新消息」)。
 * index = 行在数据里的下标,-1 = 比窗口最早一条还早;null = 还判不了(行还没进窗口)。enabled = 列表已落位显形。
 */
export function useRowAboveViewport(scrollerRef: RefObject<HTMLElement | null>, messageId: string | undefined, index: number | null, enabled: boolean): boolean {
  const [state, setState] = useState<{ id?: string; above: boolean; seen: boolean }>({ above: false, seen: false })
  const seen = state.id === messageId && state.seen
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !messageId || index === null || !enabled || seen) return
    const place = () => {
      const where = rowPlacement(scroller, messageId, index)
      setState((s) => (s.id === messageId && (s.seen || (s.above === (where === 'above') && where !== 'visible')) ? s
        : { id: messageId, above: where === 'above', seen: where === 'visible' }))
    }
    place()
    scroller.addEventListener('scroll', place, { passive: true })
    return () => scroller.removeEventListener('scroll', place)
  }, [scrollerRef, messageId, index, enabled, seen])
  return state.id === messageId && state.above && !seen
}
