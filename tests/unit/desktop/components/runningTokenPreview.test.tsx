// @vitest-environment jsdom
//
// 2026-09-29 手机:点(或长按)运行条上的 token,详情卡一开一关地闪个不停。卡片跟着 token 的焦点开合,
// 而弹层打开时把焦点挪进卡里(token blur → 关),关时又把焦点还回 token(focus → 开)。
// 手机上的手势(owner 定):短按 = @ 它,长按 = 看详情,松手卡片留着,点别处收起。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/components/MessagePreviewCard', () => ({
  MessagePreviewCard: () => <div data-testid="preview-card"><button type="button">open</button></div>,
}))

const { RunningTokenBar } = await import('../../../../apps/desktop/src/components/RunningTokenBar')

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())

const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })
const card = () => document.body.querySelector('[data-testid="preview-card"]')
const trigger = () => document.body.querySelector<HTMLElement>('[data-message-preview-trigger="agent-1"]')!

const renderBar = (onTokenClick?: (id: string) => void) => harness.render(
  <RunningTokenBar
    cap={3}
    previewChatId="chat-1"
    onTokenClick={onTokenClick}
    tokens={[{ id: 'agent-1', name: 'Pico', avatarUrl: null, avatarSeed: 'agent-1', stateKey: 'running', toolCount: 2, lastActiveAt: null }]}
  />,
)

function touch(target: Element, type: string, x = 20, y = 20) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
  Object.defineProperty(event, 'pointerType', { value: 'touch' })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  Object.defineProperty(event, 'isPrimary', { value: true })
  target.dispatchEvent(event)
  return event
}
const pressDown = (target: Element) => act(async () => { touch(target, 'pointerdown') })
// 手机浏览器松手:pointerup → touchend;touchend 没被 preventDefault 才补发兼容鼠标事件
// (mouseover → mousedown → focus → mouseup → click)。
const release = (target: HTMLElement) => act(async () => {
  touch(target, 'pointerup')
  if (!target.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }))) return
  touch(target, 'mouseover')
  touch(target, 'mousedown')
  target.focus()
  touch(target, 'mouseup')
  touch(target, 'click')
})

describe('运行条 token 的详情卡:焦点给到 token 后卡片开着不闪', () => {
  it('token 拿到焦点 → 卡片打开,焦点留在 token 上,卡片一直开着;token 失焦才收起', async () => {
    await renderBar()
    const token = trigger()
    await act(async () => { token.focus() })
    await wait(450)
    expect(card()).not.toBeNull()
    expect(document.activeElement).toBe(token)
    await wait(900)
    expect(card()).not.toBeNull()
    expect(document.activeElement).toBe(token)

    await act(async () => { token.blur() })
    await wait(600)
    expect(card()).toBeNull()
  })
})

// 2026-10-06 owner 桌面群聊:悬停 token 开卡,鼠标挪开,卡片收起后又自己弹回来。悬停开卡时焦点在 body,
// Base UI 关弹层时把焦点「还」给 token,token 一 focus 300ms 后又开。
describe('桌面:悬停开的卡,鼠标挪开就收起', () => {
  it('悬停 → 卡片打开、焦点不动;挪开 → 收起,之后不再自己弹回来', async () => {
    await renderBar()
    const token = trigger()
    await act(async () => { token.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })) })
    await wait(450)
    expect(card()).not.toBeNull()
    expect(document.activeElement).toBe(document.body)

    await act(async () => { token.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
    await wait(1200)
    expect(card()).toBeNull()
    expect(document.activeElement).not.toBe(token)
  })
})

describe('手机:短按 @ 它,长按看详情', () => {
  const desktopWidth = window.innerWidth
  beforeEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 }) })
  afterEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: desktopWidth }) })

  it('短按:@ 它,不弹卡', async () => {
    const onTokenClick = vi.fn()
    await renderBar(onTokenClick)
    await pressDown(trigger())
    await wait(120)
    await release(trigger())
    await wait(700)
    expect(onTokenClick).toHaveBeenCalledWith('agent-1')
    expect(card()).toBeNull()
  })

  it('长按:卡片打开,松手不算 @、卡片留着;点别处收起', async () => {
    const onTokenClick = vi.fn()
    await renderBar(onTokenClick)
    await pressDown(trigger())
    await wait(600)
    expect(card()).not.toBeNull()
    expect(touch(trigger(), 'contextmenu').defaultPrevented).toBe(true)
    await release(trigger())
    await wait(900)
    expect(onTokenClick).not.toHaveBeenCalled()
    expect(card()).not.toBeNull()

    await pressDown(document.body)
    await release(document.body)
    await wait(300)
    expect(card()).toBeNull()
  })

  it('按住滑开:不开卡', async () => {
    await renderBar(vi.fn())
    await act(async () => { touch(trigger(), 'pointerdown', 20, 20); touch(trigger(), 'pointermove', 20, 50) })
    await wait(700)
    expect(card()).toBeNull()
  })
})
