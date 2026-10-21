// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSharePopover } from '../../../../apps/desktop/src/components/sessionpage/AgentSharePopover'

// 分享浮层是**点开**的:开它就是为了去复制里面的号和链接,鼠标离开按钮 ❌ 收
// (owner 2026-09-26 实机:「鼠标一旦移开它,那个 pop up 就会消失」;#4116 曾挂过移走即收的 useHoverDismiss)。
// 几何:按钮在顶栏右上,浮层在它下方偏左。
const TRIGGER = { left: 600, top: 8, right: 628, bottom: 36 }
const POPUP = { left: 288, top: 42, right: 628, bottom: 300 }
// jsdom 没有布局,rect 全 0。移走即收那套把「全 0」当量不到、永远不收 —— 不给真数字,
// 这条用例对着旧实现也是绿的,测不出任何东西。
function stub(element: Element, rect: typeof TRIGGER): void {
  element.getBoundingClientRect = () =>
    ({
      ...rect,
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      toJSON: () => rect,
    }) as DOMRect
}
function move(x: number, y: number): void {
  act(() => {
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, buttons: 0, bubbles: true }))
  })
}

let anchorEl: HTMLButtonElement
let container: HTMLDivElement
let root: Root
let closed: number

beforeEach(() => {
  vi.useFakeTimers()
  closed = 0
  anchorEl = document.createElement('button')
  stub(anchorEl, TRIGGER)
  document.body.appendChild(anchorEl)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      createElement(AgentSharePopover, {
        name: 'Codex 8',
        guguNumber: 123456,
        agentUserId: 'agent-id-1234567890',
        inviteUrl: 'https://example.test/invite',
        anchor: () => anchorEl,
        onOpenPoster: () => {},
        onMakePublic: async () => {},
        onClose: () => {
          closed += 1
        },
      }),
    )
  })
  const popup = document.querySelector('[role="dialog"]')
  if (!popup) throw new Error('浮层没画出来')
  stub(popup, POPUP)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  anchorEl.remove()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('AgentSharePopover 点开后常驻', () => {
  it('指针从按钮上走开、停在别处,浮层不收', () => {
    move(614, 20) // 按钮上
    move(200, 600) // 走开
    act(() => void vi.advanceTimersByTime(2000))
    expect(closed).toBe(0)
  })

  it('指针移出窗口,浮层也不收', () => {
    move(614, 20)
    act(() => {
      document.dispatchEvent(new MouseEvent('pointerleave'))
    })
    act(() => void vi.advanceTimersByTime(2000))
    expect(closed).toBe(0)
  })

  // 对照:上面两条的 0 得是「没收」,而不是 closed 根本数不到。关闭钮走的就是同一个 onClose。
  it('点关闭钮会收', () => {
    const close = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label]')
    if (!close) throw new Error('没有关闭钮')
    act(() => close.click())
    expect(closed).toBe(1)
  })
})
