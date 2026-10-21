import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref, type RefObject } from 'react'

/**
 * 消息列表的滚动机制(#6595):整个消息窗口按文档流排(store 已把窗口限在 MAX_WINDOW 行内),位置交给浏览器。
 *
 * 为什么不再用虚拟列表:react-virtuoso 关掉原生滚动锚定(overflow-anchor:none),自己用 JS 补偿 —— 视口上方任何一行
 * 变高(第一次露出来、翻页插在上面、图片/代码高亮晚到),它先挪 scrollTop、下一次 React 提交才补上高度,中间那一帧
 * 就是一次回跳(owner:「往上滚看历史 ui 有点震荡」)。文档流 + 原生锚定由浏览器在同一次排版里改位置,画出来已经对了;
 * 我们自己动位置的地方(落点、贴底、翻页)也都放在布局之后、绘制之前(layout effect / ResizeObserver 回调)。
 *
 * 首帧只渲染落点附近填满视口的那几行(落点在布局后放好、不够就再补,都在第一次绘制之前),下一帧再把窗口其余的行补齐:
 * 一次排出整窗 markdown(代码块、表格)会把第一帧拖慢几十毫秒。补在上方的行由头部插行那一步把正看着的行钉在原处。
 */

const FIRST_FRAME_ROWS = 6
const GROW_ROWS = 12
const FILL_MARGIN_PX = 200

export type ListLanding =
  | { index: 'LAST'; align: 'end' }
  | { index: number; align: 'start'; offset?: number }

export interface FlowListHandle {
  scrollToIndex(location: { index: number; align?: 'start' | 'center' | 'end'; offset?: number; behavior?: ScrollBehavior }): void
  autoscrollToBottom(): void
}

export const isAtListEnd = (element: HTMLElement, threshold: number) => element.scrollHeight - element.clientHeight - element.scrollTop <= threshold

/** 数据下标为 index 的行(行根带 aria-posinset = 下标 + 1,见 MessageRow)。 */
function rowAt(content: HTMLElement, index: number): HTMLElement | null {
  const child = content.children[index]
  return child instanceof HTMLElement && child.getAttribute('aria-posinset') === String(index + 1)
    ? child
    : content.querySelector<HTMLElement>(`:scope > [aria-posinset="${index + 1}"]`)
}

/** 把列表放到落点:最新一条贴底;锚点行的上沿离视口顶 -offset 像素(与滚动记忆离开时量的同一个矩形)。 */
export function placeAtLanding(scroller: HTMLElement, content: HTMLElement, landing: ListLanding): void {
  if (landing.index === 'LAST') { scroller.scrollTop = scroller.scrollHeight; return }
  const row = rowAt(content, landing.index)
  if (!row) { scroller.scrollTop = scroller.scrollHeight; return }
  scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + (landing.offset ?? 0)
}

/**
 * 一次挂载(resetKey)的滚动行为:落点、贴底跟随、在不在底部的电平、到顶回调、命令式句柄。
 * scroller / content 是文档流列表的滚动容器与内容层;landing 按挂载读一次(null = 落点未定,先按最新处放)。
 */
type Slice = { key: string | number | undefined; fromId: string | undefined; toId: string | undefined; full: boolean }
// 首帧那一段:最新处 = 最后几行;锚点 = 它上面一行起往下几行。toId 为空 = 一直到末尾(新消息照常接上)。
function firstSlice(key: Slice['key'], landing: ListLanding, ids: ReadonlyArray<string>): Slice {
  if (landing.index === 'LAST') return { key, fromId: ids[Math.max(0, ids.length - FIRST_FRAME_ROWS)], toId: undefined, full: false }
  return { key, fromId: ids[Math.max(0, landing.index - 1)], toId: ids[Math.min(ids.length - 1, landing.index + FIRST_FRAME_ROWS)], full: false }
}

export function useFlowList({ scrollerRef, contentRef, resetKey, rowIds, landing, followTail, atBottomThreshold, onAtBottomChange, onTotalHeightChanged, onStartReached, handleRef }: {
  scrollerRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
  resetKey: string | number | undefined
  /** 窗口里每一行的身份,按顺序。 */
  rowIds: ReadonlyArray<string>
  landing: ListLanding | null
  followTail: boolean
  atBottomThreshold: number
  onAtBottomChange?: (atBottom: boolean) => void
  onTotalHeightChanged?: () => void
  onStartReached?: () => void
  handleRef?: Ref<FlowListHandle>
}): { start: number; end: number } {
  const atBottomRef = useRef(true)
  const reportedRef = useRef<boolean | null>(null)
  const followRef = useRef(followTail)
  followRef.current = followTail
  const callbacksRef = useRef({ onAtBottomChange, onTotalHeightChanged, onStartReached })
  callbacksRef.current = { onAtBottomChange, onTotalHeightChanged, onStartReached }

  // 读者正看着的那一行与它离视口顶的距离;头部插行时按它放回原处。取上沿在视口里的第一行,且不取窗口第一行:
  // 前面接进消息后,原来的第一行会丢掉自己的日期/发言人头(矮三十多像素),钉它等于让它下面的内容整体上跳。
  const anchorRef = useRef<{ row: Element; top: number } | null>(null)
  const capture = useCallback((scroller: HTMLElement) => {
    const content = contentRef.current
    const view = scroller.getBoundingClientRect()
    const visible = content ? Array.from(content.children).filter((child) => { const r = child.getBoundingClientRect(); return r.bottom > view.top && r.top < view.bottom }) : []
    const row = visible.find((child) => child.getAttribute('aria-posinset') !== '1' && child.getBoundingClientRect().top >= view.top) ?? visible[0]
    anchorRef.current = row ? { row, top: row.getBoundingClientRect().top - view.top } : null
  }, [contentRef])

  const report = useCallback((scroller: HTMLElement) => {
    const atBottom = isAtListEnd(scroller, atBottomThreshold)
    atBottomRef.current = atBottom
    if (reportedRef.current !== atBottom) {
      reportedRef.current = atBottom
      callbacksRef.current.onAtBottomChange?.(atBottom)
    }
  }, [atBottomThreshold])

  // 落点按挂载读一次 —— 调用方的落点在恢复落定后会变。
  const landingRef = useRef({ key: resetKey, landing })
  if (landingRef.current.key !== resetKey) landingRef.current = { key: resetKey, landing }
  const [slice, setSlice] = useState<Slice>(() => firstSlice(resetKey, landing ?? { index: 'LAST', align: 'end' }, rowIds))
  if (slice.key !== resetKey) setSlice(firstSlice(resetKey, landingRef.current.landing ?? { index: 'LAST', align: 'end' }, rowIds))
  const from = slice.full ? 0 : rowIds.indexOf(slice.fromId ?? '')
  const to = slice.full || slice.toId === undefined ? -1 : rowIds.indexOf(slice.toId)
  const start = Math.max(0, from)
  const end = to < 0 ? rowIds.length : to + 1

  // 落点:挂载那次提交之后、第一次绘制之前;首帧那段不够填满视口就再补一段(同步重渲,仍在绘制之前)再放一次。
  const paintedRef = useRef<Slice['key'] | null>(null)
  useLayoutEffect(() => {
    const scroller = scrollerRef.current, content = contentRef.current
    if (!scroller || !content || paintedRef.current === resetKey) return
    const target = landingRef.current.landing ?? { index: 'LAST', align: 'end' }
    reportedRef.current = null
    placeAtLanding(scroller, content, target)
    report(scroller)
    capture(scroller)
    // 首帧那段够不够:最新处要比视口高出一截;锚点要真的落在该在的位置(不够时浏览器会把 scrollTop 夹住),且下方不留白。
    const view = scroller.getBoundingClientRect()
    const anchor = target.index === 'LAST' ? null : rowAt(content, target.index)
    const lastBottom = content.lastElementChild?.getBoundingClientRect().bottom ?? view.top
    const needAbove = start > 0 && (target.index === 'LAST'
      ? scroller.scrollHeight < scroller.clientHeight + FILL_MARGIN_PX
      : !anchor || Math.abs(anchor.getBoundingClientRect().top - view.top + (target.offset ?? 0)) > 1)
    const needBelow = end < rowIds.length && lastBottom < view.bottom + FILL_MARGIN_PX
    if (needAbove || needBelow) {
      setSlice((s) => (s.key !== resetKey || s.full ? s : {
        ...s,
        fromId: needAbove ? rowIds[Math.max(0, start - GROW_ROWS)] : s.fromId,
        toId: needBelow && s.toId !== undefined ? rowIds[Math.min(rowIds.length - 1, end - 1 + GROW_ROWS)] : s.toId,
      }))
    }
  }, [resetKey, start, end, rowIds, scrollerRef, contentRef, report, capture])
  // 第一次绘制之后的下一帧补齐整窗(两层 rAF:点击触发的提交里,一层 rAF 仍在这一帧的绘制之前)。
  useEffect(() => {
    let inner = 0
    const outer = requestAnimationFrame(() => {
      paintedRef.current = resetKey
      inner = requestAnimationFrame(() => setSlice((s) => (s.key === resetKey && !s.full ? { ...s, full: true } : s)))
    })
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner) }
  }, [resetKey])
  const headKey = rowIds[start]

  // 头部插进一页旧消息(或窗口从头部裁掉几行):把读者正看着的那一行放回原处,在这次提交的绘制之前。
  // 浏览器的原生锚定多数时候已经做了(这里读到的差就是 0);它不管的是滚动条正好顶在 0 的时候,以及不支持锚定的 WebKit。
  useLayoutEffect(() => {
    const scroller = scrollerRef.current, anchor = anchorRef.current
    if (!scroller || !anchor || !anchor.row.isConnected || (followRef.current && atBottomRef.current)) return
    const delta = anchor.row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.top
    if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
    capture(scroller)
  }, [headKey, scrollerRef, capture])

  // 内容长高/变矮:在底部就贴住(新消息、最后一条长高、图片晚到);ResizeObserver 在布局之后、绘制之前回调。
  // 不在底部时视口上方的变化交给浏览器的滚动锚定,这里不动。
  useEffect(() => {
    const scroller = scrollerRef.current, content = contentRef.current
    if (!scroller || !content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (followRef.current && atBottomRef.current) scroller.scrollTop = scroller.scrollHeight
      callbacksRef.current.onTotalHeightChanged?.()
      report(scroller)
    })
    observer.observe(content)
    const onScroll = () => {
      report(scroller)
      capture(scroller)
      if (scroller.scrollTop <= 120) callbacksRef.current.onStartReached?.()
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => { observer.disconnect(); scroller.removeEventListener('scroll', onScroll) }
  }, [resetKey, scrollerRef, contentRef, report, capture])

  useImperativeHandle(handleRef, () => ({
    scrollToIndex: ({ index, align = 'start', offset = 0, behavior }) => {
      const scroller = scrollerRef.current, content = contentRef.current
      const row = scroller && content ? rowAt(content, index) : null
      if (!scroller || !row) return
      const view = scroller.getBoundingClientRect(), rect = row.getBoundingClientRect()
      const top = scroller.scrollTop + rect.top - view.top
      const target = align === 'start' ? top : align === 'end' ? top + rect.height - view.height : top + rect.height / 2 - view.height / 2
      scroller.scrollTo({ top: target + offset, behavior })
    },
    autoscrollToBottom: () => {
      const scroller = scrollerRef.current
      if (scroller) scroller.scrollTop = scroller.scrollHeight
    },
  }), [scrollerRef, contentRef])
  return { start, end }
}
