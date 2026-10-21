import { useEffect, useRef, type RefObject } from 'react'

const NEAR_TOP_PX = 120
/** 请求落定后,新的一页最迟多久画出来;过了还没画(翻不动 / 失败)就不再钉。 */
const LANDING_GRACE_MS = 1500

export type AnchorRow = { id: string; top: number }

/** 视口要挪多少,读者原先看着的那一行才回到原位;那一行不在 = null(不动)。 */
export function pinDelta(anchor: AnchorRow, topNow: (id: string) => number | null): number | null {
  const top = topNow(anchor.id)
  return top === null ? null : top - anchor.top
}

/**
 * 请求发出去以后读者的手指还在拖:新的一页还没进来(第一行还是发请求时那一行)就把锚换成读者此刻看着的那一行,
 * 钉回的是插入前一刻的位置,❌ 发请求那一刻的(那样会把这段时间拖动的距离一下子抹掉)。新的一页已经在 DOM 里 =
 * 不再换,留给钉位去用。
 */
export function followAnchor(anchor: { firstId: string | null; row: AnchorRow }, now: readonly AnchorRow[]): AnchorRow {
  if (now[0]?.id !== anchor.firstId) return anchor.row
  return now.find((row) => row.top >= 0) ?? anchor.row
}

/**
 * 滚到顶就往前翻一页,新的一页排好之后、绘制之前(ResizeObserver 回调)把读者正看着的行放回原处:
 * 原生滚动锚定在 scrollTop=0 时不生效、WebKit 不支持。行按 `data-message-id` 认。
 * 观察器跟挂载同寿:新的一页落地的那次提交里 hasOlder 也会变,重建观察器会错过那一帧。
 */
export function useLoadOlderOnTop(hostRef: RefObject<HTMLElement | null>, hasOlder: boolean, loadOlder: () => Promise<void>): void {
  const anchorRef = useRef<{ firstId: string | null; row: AnchorRow; until: number } | null>(null)
  const latest = useRef({ hasOlder, loadOlder })
  latest.current = { hasOlder, loadOlder }
  useEffect(() => {
    const viewport = hostRef.current?.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]')
    const content = viewport?.querySelector<HTMLElement>('[data-slot="aui_message-group"]')
    if (!viewport || !content) return
    const rows = (): AnchorRow[] => {
      const viewTop = viewport.getBoundingClientRect().top
      return [...content.querySelectorAll('[data-message-id]')].map((el) => ({ id: el.getAttribute('data-message-id') ?? '', top: el.getBoundingClientRect().top - viewTop }))
    }
    const live = () => (anchorRef.current && performance.now() <= anchorRef.current.until ? anchorRef.current : null)
    const pin = () => {
      const anchor = live()
      const now = rows()
      if (!anchor || now[0]?.id === anchor.firstId) return
      anchorRef.current = null
      const delta = pinDelta(anchor.row, (id) => now.find((row) => row.id === id)?.top ?? null)
      if (delta !== null && Math.abs(delta) > 0.5) viewport.scrollTo({ top: viewport.scrollTop + delta, behavior: 'instant' })
    }
    const onScroll = () => {
      const pending = live()
      if (pending) {
        pending.row = followAnchor(pending, rows())
        return
      }
      if (!latest.current.hasOlder || viewport.scrollTop > NEAR_TOP_PX) return
      const now = rows()
      const row = now.find((r) => r.top >= 0)
      if (!row) return
      const anchor = { firstId: now[0]?.id ?? null, row, until: Number.POSITIVE_INFINITY }
      anchorRef.current = anchor
      void latest.current.loadOlder().finally(() => { anchor.until = performance.now() + LANDING_GRACE_MS })
    }
    // 内容还撑不满视口就没有滚动事件可等:直接去要下一页,❌ 让更早的轮永远够不着。
    const observer = new ResizeObserver(() => {
      pin()
      if (viewport.scrollHeight <= viewport.clientHeight) onScroll()
    })
    observer.observe(content)
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      viewport.removeEventListener('scroll', onScroll)
    }
  }, [hostRef])
}
