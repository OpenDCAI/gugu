// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from '../../../../apps/desktop/src/components/chat/MessageBubble'
import { MemberProfilePopover } from '../../../../apps/desktop/src/components/MemberProfilePopover'
import { ReadReceiptPopover } from '../../../../apps/desktop/src/components/ReadReceiptPopover'
import { Menu, MenuItem } from '../../../../apps/desktop/src/components/ui/Menu'
import { Popover } from '../../../../apps/desktop/src/components/ui/Popover'
import { createNode, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))

let harness: ReturnType<typeof createReactHarness>
// jsdom's layout viewport is 0×0, which would make every popup "collide" and flip. Give it a real size.
beforeEach(() => {
  harness = createReactHarness()
  Object.defineProperty(document.documentElement, 'clientWidth', { value: 1024, configurable: true })
  Object.defineProperty(document.documentElement, 'clientHeight', { value: 768, configurable: true })
})
afterEach(() => {
  harness.cleanup()
  Reflect.deleteProperty(document.documentElement, 'clientWidth')
  Reflect.deleteProperty(document.documentElement, 'clientHeight')
})

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
}

async function hoverBubble() {
  const bubble = harness.container.querySelector('[data-testid="message-bubble-action-target"]')!
  const over = new MouseEvent('pointerover', { bubbles: true })
  Object.defineProperty(over, 'pointerType', { value: 'mouse' })
  await act(async () => { bubble.dispatchEvent(over) })
  await settle()
}

function buttonAt(rect: { x: number; y: number }) {
  const button = document.createElement('button')
  document.body.appendChild(button)
  let current = rect
  button.getBoundingClientRect = () => new DOMRect(current.x, current.y, 32, 32)
  return { button, moveTo: (next: { x: number; y: number }) => { current = next } }
}

function positioner() {
  const node = document.querySelector('.gg-menu-positioner') as HTMLElement | null
  expect(node).not.toBeNull()
  return node!
}

describe('overlay anchors (2a)', () => {
  it('a menu opened from a button follows the button when the list moves', async () => {
    const { button, moveTo } = buttonAt({ x: 300, y: 400 })
    await harness.render(createElement(Menu, { anchor: button, children: createElement(MenuItem, null, 'copy') }))
    await settle()
    expect(positioner().style.transform).toBe('translate(300px, 438px)')
    moveTo({ x: 300, y: 100 })
    await act(async () => { window.dispatchEvent(new Event('resize')) })
    await settle()
    expect(positioner().style.transform).toBe('translate(300px, 138px)')
    button.remove()
  })

  it('a context menu still opens at the pointer coordinate', async () => {
    await harness.render(createElement(Menu, { x: 120, y: 240, children: createElement(MenuItem, null, 'copy') }))
    await settle()
    expect(positioner().style.transform).toBe('translate(120px, 240px)')
  })

  it('popover positioner opts out of the window drag region', async () => {
    const { button } = buttonAt({ x: 10, y: 10 })
    await harness.render(createElement(Popover.Root, { open: true },
      createElement(Popover.Portal, null,
        createElement(Popover.Positioner, { anchor: button },
          createElement(Popover.Popup, null, 'card')))))
    await settle()
    const node = document.querySelector('[data-slot="popover-positioner"]')
    expect(node?.classList.contains('window-no-drag-region')).toBe(true)
    button.remove()
  })

  it.each([
    ['更多', '.gg-menu-positioner'],
    ['表情回应', '[data-slot="popover-positioner"]:has([role="toolbar"][aria-label="快速回应"])'],
  ])('message hover-bar 「%s」 anchors its overlay to the button itself', async (title, selector) => {
    await renderWithAppProviders(harness, createNode(MessageBubble, {
      msg: message({ id: 'msg-1', content: 'hi', is_mine: false, sender_user_id: 'sender-1', created_at: '2026-05-24T00:00:00.000Z' }),
      onReaction: vi.fn(), memberReadSeqs: {}, onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(), isGroup: true,
    }))
    await hoverBubble()
    const button = document.querySelector(`button[title="${title}"]`) as HTMLButtonElement
    expect(button).not.toBeNull()
    let rect = new DOMRect(500, 300, 32, 32)
    button.getBoundingClientRect = () => rect
    await act(async () => { button.click() })
    await act(async () => { await vi.dynamicImportSettled() })
    await settle()
    const node = () => document.querySelector(selector) as HTMLElement
    expect(node().style.transform).toBe('translate(500px, 338px)')
    rect = new DOMRect(500, 120, 32, 32)
    await act(async () => { window.dispatchEvent(new Event('resize')) })
    await settle()
    expect(node().style.transform).toBe('translate(500px, 158px)')
  })

  it.each([[false, 'flex'], [true, 'none']])('#6850 a mouse hover shows the action bar only on the desktop shell (compactMobile=%s → %s): phone message actions go through long-press', async (compactMobile, display) => {
    await renderWithAppProviders(harness, createNode(MessageBubble, {
      msg: message({ id: 'msg-1', content: 'hi', is_mine: false, sender_user_id: 'sender-1', created_at: '2026-05-24T00:00:00.000Z' }),
      onReaction: vi.fn(), memberReadSeqs: {}, onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(), isGroup: true, compactMobile,
    }))
    const bubble = harness.container.querySelector('[data-testid="message-bubble-action-target"]') as HTMLElement
    const over = new MouseEvent('pointerover', { bubbles: true })
    Object.defineProperty(over, 'pointerType', { value: 'mouse' })
    await act(async () => { bubble.dispatchEvent(over) })
    const bar = document.querySelector<HTMLElement>('[data-testid="message-hover-actions"]')
    if (compactMobile) expect(bar).toBeNull()
    else expect(bar?.style.display).toBe(display)
  })

  it.each([true, false])('hover action bar sits on the bubble row, not the message column edge (isMine=%s)', async (isMine) => {
    await renderWithAppProviders(harness, createNode(MessageBubble, {
      msg: message({ id: 'msg-1', content: 'hi', is_mine: isMine, sender_user_id: 'sender-1', created_at: '2026-05-24T00:00:00.000Z' }),
      onReaction: vi.fn(), memberReadSeqs: {}, onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(), isGroup: true,
    }))
    const bubble = harness.container.querySelector('[data-testid="message-bubble-action-target"]') as HTMLElement
    const anchor = bubble.closest('[data-message-bubble-row]') as HTMLElement
    const readAnchor = vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 300, 100, 40))
    const composer = document.createElement('input')
    document.body.append(composer)
    composer.focus()
    await hoverBubble()
    const bar = document.querySelector<HTMLElement>('[data-testid="message-hover-actions"]')!
    expect(bar).not.toBeNull()
    expect(readAnchor).toHaveBeenCalled()
    expect(anchor.style.width).toBe('fit-content')
    expect(anchor.style.marginLeft).toBe(isMine ? 'auto' : '')
    expect(harness.container.contains(bar)).toBe(false)
    expect(bar.closest<HTMLElement>('[data-slot="popover-positioner"]')?.style.position).toBe('fixed')
    expect(document.activeElement).toBe(composer)
    composer.remove()
  })

  it.each(['member profile card', 'read receipt list'])('%s follows the element that opened it', async (kind) => {
    const { button, moveTo } = buttonAt({ x: 200, y: 300 })
    const node = kind === 'member profile card'
      ? createNode(MemberProfilePopover, {
          profile: { member: { id: 'u-1', displayName: 'Ada', avatar: null, email: null, bio: null, type: 'human', role: 'member', profileScope: 'group' }, anchor: button, preferredSide: 'left' },
          onClose: vi.fn(),
        })
      : createNode(ReadReceiptPopover, { anchor: button, readers: [], unreaders: [] })
    await renderWithAppProviders(harness, node)
    await settle()
    const positionerNode = document.querySelector('[data-slot="popover-positioner"]') as HTMLElement
    const before = positionerNode.style.transform
    moveTo({ x: 200, y: 100 })
    await act(async () => { window.dispatchEvent(new Event('resize')) })
    await settle()
    const after = positionerNode.style.transform
    expect(before).toMatch(/^translate\(/)
    // 同一个水平位置,垂直方向随按钮上移了 200px
    const y = (transform: string) => Number(/translate\([-\d.]+px, ([-\d.]+)px\)/.exec(transform)?.[1])
    expect(y(before) - y(after)).toBe(200)
    button.remove()
  })
})
