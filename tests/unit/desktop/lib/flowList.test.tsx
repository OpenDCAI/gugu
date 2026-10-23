// @vitest-environment jsdom
// #6595 消息列表的滚动机制:整个窗口按文档流排,落点 / 贴底 / 头部插行都在布局之后、绘制之前改位置。
// jsdom 没有布局:这里给一个最小的几何模型 —— 视口高 300、行高各自给定,行的屏幕位置 = 累计高度 − scrollTop,
// scrollTop 按浏览器那样夹在 [0, scrollHeight − clientHeight]。ResizeObserver 换成可手动触发的替身。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useRef } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { useFlowList, type FlowListHandle, type ListLanding } from '../../../../apps/desktop/src/lib/flowList'

const VIEW = 300
const scrollTops = new WeakMap<Element, number>()
const heightsOf = (scroller: Element) => Array.from(scroller.firstElementChild?.children ?? []).map((row) => Number((row as HTMLElement).dataset.h))
const total = (scroller: Element) => heightsOf(scroller).reduce((a, b) => a + b, 0)
const maxTop = (scroller: Element) => Math.max(0, total(scroller) - VIEW)
const descriptors = {
  scrollHeight: { configurable: true, get(this: HTMLElement) { return this.dataset.scroller !== undefined ? total(this) : 0 } },
  clientHeight: { configurable: true, get(this: HTMLElement) { return this.dataset.scroller !== undefined ? VIEW : 0 } },
  scrollTop: {
    configurable: true,
    get(this: HTMLElement) { return scrollTops.get(this) ?? 0 },
    set(this: HTMLElement, value: number) { scrollTops.set(this, Math.min(maxTop(this), Math.max(0, value))) },
  },
}
function rect(this: HTMLElement): DOMRect {
  if (this.dataset.scroller !== undefined) return { top: 0, bottom: VIEW, height: VIEW } as DOMRect
  const scroller = this.closest<HTMLElement>('[data-scroller]')
  if (this.dataset.h === undefined || !scroller) return { top: 0, bottom: 0, height: 0 } as DOMRect
  const rows = Array.from(this.parentElement!.children) as HTMLElement[]
  const offset = rows.slice(0, rows.indexOf(this)).reduce((sum, row) => sum + Number(row.dataset.h), 0)
  const top = offset - scroller.scrollTop
  return { top, bottom: top + Number(this.dataset.h), height: Number(this.dataset.h) } as DOMRect
}

const observers: Array<() => void> = []
class FakeResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe() { observers.push(this.callback) }
  disconnect() { const i = observers.indexOf(this.callback); if (i >= 0) observers.splice(i, 1) }
  unobserve() {}
}
const resize = () => act(async () => { for (const callback of [...observers]) callback() })
// 首帧只渲染落点附近那段,第一次绘制之后的下一帧补齐整窗(两层 rAF)。
const nextFrames = () => act(async () => { for (let i = 0; i < 3; i += 1) await new Promise((resolve) => requestAnimationFrame(() => resolve(null))) })

type Row = { id: string; h: number }
const rowsOf = (n: number, h = 100, prefix = 'r') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, h }))
let harness: ReturnType<typeof createReactHarness>
const handleRef: { current: FlowListHandle | null } = { current: null }
const events = { atBottom: [] as boolean[], startReached: 0 }
function List({ rows, landing, resetKey = 'k', followTail = true }: { rows: Row[]; landing: ListLanding | null; resetKey?: string; followTail?: boolean }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const { start, end } = useFlowList({
    scrollerRef, contentRef, resetKey, rowIds: rows.map((row) => row.id), landing, followTail, atBottomThreshold: 80, handleRef,
    onAtBottomChange: (atBottom) => events.atBottom.push(atBottom), onStartReached: () => { events.startReached += 1 },
  })
  return createElement('div', { key: resetKey, ref: scrollerRef, 'data-scroller': '' },
    createElement('div', { ref: contentRef }, ...rows.slice(start, end).map((row, i) => createElement('div', { key: row.id, 'data-h': row.h, 'data-id': row.id, 'aria-posinset': start + i + 1 }))))
}
const scroller = () => harness.container.querySelector<HTMLElement>('[data-scroller]')!
const rendered = () => Array.from(scroller().firstElementChild!.children).map((row) => (row as HTMLElement).dataset.id)
const topOf = (id: string) => harness.container.querySelector<HTMLElement>(`[data-id="${id}"]`)!.getBoundingClientRect().top
const scrollTo = (top: number) => act(async () => { scroller().scrollTop = top; scroller().dispatchEvent(new Event('scroll')) })

beforeEach(() => {
  Object.defineProperties(HTMLElement.prototype, descriptors)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(rect)
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  harness = createReactHarness()
  events.atBottom = []; events.startReached = 0
})
afterEach(() => {
  harness.cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const key of Object.keys(descriptors)) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
  observers.length = 0
})

describe('useFlowList 落点(第一次绘制之前放好)', () => {
  it('最新一条:首帧只排最后那段并贴到它的底;下一帧补齐整窗后仍在真底', async () => {
    await harness.render(createElement(List, { rows: rowsOf(20), landing: { index: 'LAST', align: 'end' } }))
    expect(rendered()).toEqual(rowsOf(6).map((_, i) => `r${14 + i}`))
    expect(topOf('r19')).toBe(200)
    expect(events.atBottom).toEqual([true])
    await nextFrames()
    await resize()
    expect(rendered()).toHaveLength(20)
    expect(scroller().scrollTop).toBe(1700)
    expect(topOf('r19')).toBe(200)
  })
  it('读到一半的那一行:首帧它的上沿就离视口顶 -offset;上方补齐后它不动', async () => {
    await harness.render(createElement(List, { rows: rowsOf(20), landing: { index: 5, align: 'start', offset: 16 } }))
    expect(rendered()).toEqual(['r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11'])
    expect(topOf('r5')).toBe(-16)
    expect(events.atBottom).toEqual([false])
    await nextFrames()
    expect(rendered()).toHaveLength(20)
    expect(topOf('r5')).toBe(-16)
  })
  it('首帧那段不够填满视口(行矮)就再补一段,仍在第一次绘制之前放好', async () => {
    await harness.render(createElement(List, { rows: rowsOf(40, 20), landing: { index: 'LAST', align: 'end' } }))
    expect(rendered().length).toBeGreaterThanOrEqual(25)
    expect(topOf('r39')).toBe(280)
  })
  it('落点按挂载读一次:同一条线里调用方换了落点不再动;换一条线(resetKey)按新落点放', async () => {
    await harness.render(createElement(List, { rows: rowsOf(20), landing: { index: 5, align: 'start' } }))
    await nextFrames()
    await harness.render(createElement(List, { rows: rowsOf(20), landing: { index: 'LAST', align: 'end' } }))
    expect(topOf('r5')).toBe(0)
    await harness.render(createElement(List, { rows: rowsOf(20, 100, 'b'), landing: { index: 'LAST', align: 'end' }, resetKey: 'k2' }))
    await nextFrames()
    await resize()
    expect(scroller().scrollTop).toBe(1700)
  })
})

describe('useFlowList 贴底', () => {
  it('在底部时内容长高(新消息 / 最后一条撑高)就贴住;往上翻开之后不拽', async () => {
    await harness.render(createElement(List, { rows: rowsOf(10), landing: { index: 'LAST', align: 'end' } }))
    await nextFrames()
    await harness.render(createElement(List, { rows: rowsOf(12), landing: null }))
    await resize()
    expect(scroller().scrollTop).toBe(900)

    await scrollTo(400)
    expect(events.atBottom.at(-1)).toBe(false)
    await harness.render(createElement(List, { rows: rowsOf(14), landing: null }))
    await resize()
    expect(scroller().scrollTop, '读历史的人不被拽回底部').toBe(400)
  })
  it('调用方关掉跟随(还有更新的页没载、正在定位未读)时在底部也不贴', async () => {
    await harness.render(createElement(List, { rows: rowsOf(10), landing: { index: 'LAST', align: 'end' }, followTail: false }))
    await nextFrames()
    await harness.render(createElement(List, { rows: rowsOf(12), landing: null, followTail: false }))
    await resize()
    expect(scroller().scrollTop).toBe(700)
  })
})

describe('useFlowList 头部插行', () => {
  it.each([0, 24])('正文晚排版后仍保留同一个锚点,原生锚定已补偿 %dpx 时不重复补偿', async (nativeCompensation) => {
    const rows = rowsOf(20)
    await harness.render(createElement(List, { rows, landing: { index: 5, align: 'start', offset: 16 } }))
    await nextFrames()
    await scrollTo(516)
    const before = topOf('r5')
    await harness.render(createElement(List, { rows: [{ ...rows[0], h: 124 }, ...rows.slice(1)], landing: null }))
    // 同一组 id、没有头部插行;模拟浏览器对延后排版只做了部分或全部补偿。
    scroller().scrollTop += nativeCompensation
    expect(topOf('r5')).toBe(before + 24 - nativeCompensation)
    await resize()
    expect(topOf('r5')).toBe(before)
    expect(scroller().scrollTop).toBe(540)
  })

  // 滚动条正好顶在 0 时浏览器的原生锚定不管;这一格就是那种情形,也覆盖不支持锚定的 WebKit。
  it('往前接一页:读者正看着的那一行留在原处(在这次提交里,不等下一帧)', async () => {
    const rows = rowsOf(10)
    await harness.render(createElement(List, { rows, landing: { index: 3, align: 'start', offset: 20 } }))
    await nextFrames()
    expect(topOf('r3')).toBe(-20)
    await harness.render(createElement(List, { rows: [...rowsOf(5, 120, 'old'), ...rows], landing: null }))
    expect(topOf('r3')).toBe(-20)

    // 阳性对照:顶在 0 时接一页,不纠正就会停在新插进来的最早一条上。
    await scrollTo(0)
    const before = topOf('old0')
    await harness.render(createElement(List, { rows: [...rowsOf(3, 80, 'older'), ...rowsOf(5, 120, 'old'), ...rows], landing: null }))
    expect(topOf('old0')).toBe(before)
    expect(scroller().scrollTop).toBe(240)
  })

  it('钉的是上沿在视口里、且不是窗口第一行的那一行:原第一行在前面接进消息后变矮(丢了日期头),它下面的内容不上跳', async () => {
    const rows = [{ id: 'first', h: 133 }, ...rowsOf(9)]
    await harness.render(createElement(List, { rows, landing: { index: 0, align: 'start' } }))
    await nextFrames()
    await scrollTo(0)
    expect(topOf('r0')).toBe(133)
    await harness.render(createElement(List, { rows: [...rowsOf(4, 100, 'old'), { id: 'first', h: 100 }, ...rowsOf(9)], landing: null }))
    expect(topOf('r0')).toBe(133)
  })
})

describe('useFlowList 句柄与回调', () => {
  it('scrollToIndex 按对齐方式定位;autoscrollToBottom 贴到真底', async () => {
    await harness.render(createElement(List, { rows: rowsOf(20), landing: { index: 'LAST', align: 'end' } }))
    await nextFrames()
    const scrollToSpy = vi.fn(function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top! })
    scroller().scrollTo = scrollToSpy as unknown as HTMLElement['scrollTo']
    act(() => handleRef.current!.scrollToIndex({ index: 6, align: 'center' }))
    expect(topOf('r6')).toBe(100)
    act(() => handleRef.current!.scrollToIndex({ index: 2, align: 'start' }))
    expect(topOf('r2')).toBe(0)
    act(() => handleRef.current!.autoscrollToBottom())
    expect(scroller().scrollTop).toBe(1700)
  })
  it('滚到离顶 120px 以内就报到顶(交给调用方翻页)', async () => {
    await harness.render(createElement(List, { rows: rowsOf(20), landing: { index: 'LAST', align: 'end' } }))
    await nextFrames()
    await scrollTo(500)
    expect(events.startReached).toBe(0)
    await scrollTo(100)
    expect(events.startReached).toBe(1)
  })
})
