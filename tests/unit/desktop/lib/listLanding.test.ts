// @vitest-environment jsdom
// 打开会话的落点(restoreLanding)与「↑ N 条新消息」的几何判定;列表的滚动机制本身在 flowList.test.tsx。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useRef } from 'react'
import { OPEN_AT_LATEST, restoreLanding, rowPlacement, useRowAboveViewport } from '../../../../apps/desktop/src/lib/listLanding'
import { createReactHarness } from '../../../support/testHarness'

// #6595 恢复读到一半的位置:列表挂载就落在那一行(第一次绘制之前放好)。
describe('restoreLanding', () => {
  it('锚点在窗口里 ⇒ 落在那一行,偏移取反交给 align start(行上沿在视口顶上方 16px ⇒ 往下多滚 16px)', () => {
    expect(restoreLanding({ messageId: 'm2', offset: -16 }, ['m1', 'm2', 'm3'])).toEqual({ index: 1, align: 'start', offset: 16 })
  })
  it('没有离底位置 ⇒ 最新一条;锚点还没载进窗口 ⇒ null(先落最新处、整块藏着)', () => {
    expect(restoreLanding(null, ['m1'])).toBe(OPEN_AT_LATEST)
    expect(restoreLanding({ messageId: 'gone', offset: 0 }, ['m1', 'm2'])).toBeNull()
  })
})

// #6530 「↑ N 条新消息」判的是真实几何:视口 0–500,行按 top 摆;jsdom 没有布局,矩形由这里给。
function viewport(rowTops: Record<string, number>, firstPosinset = 1) {
  const scroller = document.createElement('div')
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 500 } as DOMRect)
  Object.keys(rowTops).forEach((id, i) => {
    const row = document.createElement('div')
    row.dataset.msgId = id
    row.setAttribute('aria-posinset', String(firstPosinset + i))
    row.getBoundingClientRect = () => ({ top: rowTops[id], bottom: rowTops[id] + 50 } as DOMRect)
    scroller.appendChild(row)
  })
  return scroller
}

describe('rowPlacement', () => {
  it('按矩形判上方 / 看得见 / 下方;露出一截也算看得见', () => {
    const scroller = viewport({ a: -60, b: -20, c: 200, d: 520 })
    expect(rowPlacement(scroller, 'a', 0)).toBe('above')
    expect(rowPlacement(scroller, 'b', 1)).toBe('visible')
    expect(rowPlacement(scroller, 'c', 2)).toBe('visible')
    expect(rowPlacement(scroller, 'd', 3)).toBe('below')
  })
  it('行没渲染:比已渲染的第一行靠前 = 上方;比窗口最早一条还早(-1)= 上方;其余 = 下方', () => {
    const scroller = viewport({ x: 100, y: 150 }, 21)
    expect(rowPlacement(scroller, 'gone', 5)).toBe('above')
    expect(rowPlacement(scroller, 'gone', -1)).toBe('above')
    expect(rowPlacement(scroller, 'gone', 40)).toBe('below')
  })
})

describe('useRowAboveViewport', () => {
  let harness: ReturnType<typeof createReactHarness> | null = null
  afterEach(() => { harness?.cleanup(); harness = null })
  function mount(scroller: HTMLElement, index: number | null, enabled: boolean, onSeen?: () => void) {
    const seen: boolean[] = []
    function Probe(props: { index: number | null; enabled: boolean }) {
      const ref = useRef<HTMLElement | null>(scroller)
      seen.push(useRowAboveViewport(ref, 'a', props.index, props.enabled, onSeen))
      return null
    }
    harness = createReactHarness()
    return { seen, render: (next: { index: number | null; enabled: boolean }) => harness!.render(createElement(Probe, next)), first: harness.render(createElement(Probe, { index, enabled })) }
  }
  it('列表还没落位、或未读行还没进窗口(null)时不判', async () => {
    const scroller = viewport({ a: -100 })
    const view = mount(scroller, 0, false)
    await view.first
    expect(view.seen.at(-1)).toBe(false)
    await view.render({ index: null, enabled: true })
    expect(view.seen.at(-1)).toBe(false)
    await view.render({ index: 0, enabled: true })
    expect(view.seen.at(-1), '落位后在上方 ⇒ 提示').toBe(true)
  })
  it('滚到看见过一次就收,之后再滚回它下面也不再出现', async () => {
    const tops: Record<string, number> = { a: -100 }
    const scroller = viewport(tops)
    const view = mount(scroller, 0, true)
    await view.first
    expect(view.seen.at(-1)).toBe(true)
    tops.a = 100
    await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
    expect(view.seen.at(-1)).toBe(false)
    tops.a = -300
    await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
    expect(view.seen.at(-1), '看见过 ⇒ 不再提示').toBe(false)
  })
  it('一开始就看得见(未读少、一屏装得下)⇒ 从不提示', async () => {
    const scroller = viewport({ a: 300 })
    const onSeen = vi.fn()
    const view = mount(scroller, 0, false, onSeen)
    await view.first
    expect(onSeen).not.toHaveBeenCalled()
    await view.render({ index: null, enabled: true })
    expect(onSeen).not.toHaveBeenCalled()
    await view.render({ index: 0, enabled: true })
    expect(view.seen.every((shown) => !shown)).toBe(true)
    expect(onSeen).toHaveBeenCalledOnce()
    await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
    expect(onSeen).toHaveBeenCalledOnce()
  })
})
