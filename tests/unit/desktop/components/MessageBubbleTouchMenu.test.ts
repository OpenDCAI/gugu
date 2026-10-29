// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from '../../../../apps/desktop/src/components/chat/MessageBubble'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import type { ToastType } from '../../../../apps/desktop/src/components/toastContext'
import type { MemberProfileCardModel } from '../../../../apps/desktop/src/components/MemberProfileCard'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import { NATIVE_BACK_EVENT } from '../../../../apps/desktop/src/components/ui/sheetStack'
import { QUICK_REACTIONS, REACTIONS } from '../../../../packages/core/src/shared/ui/reactionCatalog'
import { TOOLTIP_OPEN_DELAY_MS } from '../../../../apps/desktop/src/styles/motion'
import { clickElement, createNode, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'
vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  vi.useFakeTimers()
  for (const key of ['gugu.reaction-frequency', 'emoji-mart.frequently', 'emoji-mart.last']) localStorage.removeItem(key)
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('MessageBubble touch menu', () => {
  it('leaves phone message text long-press to native selection', async () => {
    await renderMessage()
    await longPress(messageBubble().querySelector('.gg-md')!)
    expect(document.querySelector('[data-testid="message-action-menu"]')).toBeNull()
  })
  it('does not cancel the native context menu on selectable phone text', async () => {
    await renderMessage()
    const text = messageBubble().querySelector('.gg-md')!
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 240 })
    await act(async () => { text.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
    expect(document.querySelector('[data-testid="message-action-menu"]')).toBeNull()
  })
  it('opens the existing reaction picker directly from selected phone text', async () => {
    const onReaction = vi.fn()
    await renderMessage(undefined, true, onReaction)
    await act(async () => {
      selectMessageText('hello')
      document.dispatchEvent(new Event('selectionchange'))
      document.dispatchEvent(new Event('touchend'))
    })
    const react = document.querySelector<HTMLElement>('[data-testid="message-selection-react"]')
    expect(react?.textContent).toBe('表情回应')
    await clickElement(react!)
    await act(async () => { await vi.dynamicImportSettled() })
    const picker = document.querySelector('[role="toolbar"][aria-label="快速回应"]')!
    expect(picker).not.toBeNull()
    const heart = [...picker.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '❤️')!
    await clickElement(heart)
    expect(onReaction).toHaveBeenCalledWith('msg-1', '❤️')
  })
  it('renders previously loaded mobile reactions in the same commit when reopening the menu', async () => {
    await renderMessage(undefined, true)
    await longPress()
    await act(() => { document.dispatchEvent(new CustomEvent(UI_EVENTS.closeContextMenus)) })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await act(() => {
      flushSync(() => { messageBubble().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 240 })) })
      expect(document.querySelector('[role="group"][aria-label="快速回应"]')?.querySelectorAll('button')).toHaveLength(7)
    })
  })
  it('copies a text selection made inside the mobile menu\'s select-text view', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const toast = vi.fn()
    await renderMessage(toast)
    await longPress()
    await clickElement(document.querySelector('[data-testid="message-action-selectText"]')!)
    expect(document.querySelector('[data-testid="message-action-menu"]'), '换一屏,菜单不收').not.toBeNull()
    const text = document.querySelector<HTMLElement>('[data-testid="message-selection-text"]')!
    expect(text.textContent).toBe('hello from mobile')
    selectTextIn(text, 'from mobile')
    await clickElement(document.querySelector('[data-testid="message-action-copy"]')!)
    expect(writeText).toHaveBeenCalledWith('from mobile')
    expect(toast).toHaveBeenCalledWith('已复制', 'success')
  })
  it('routes native in-menu Copy through the same clipboard feedback', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const toast = vi.fn()
    await renderMessage(toast)
    await longPress()
    await clickElement(document.querySelector('[data-testid="message-action-selectText"]')!)
    const text = document.querySelector<HTMLElement>('[data-testid="message-selection-text"]')!
    selectTextIn(text, 'hello')
    const event = new Event('copy', { bubbles: true, cancelable: true })
    await act(async () => { text.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(toast).toHaveBeenCalledWith('已复制', 'success')
  })
  it('keeps external-link copying without resource actions on ordinary messages', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const toast = vi.fn()
    await renderMessage(toast, true, vi.fn(), { content: 'before https://example.com/path?copy=1025 after' })
    await selectPhoneLink(messageBubble().querySelector('a')!)
    expect(document.querySelector('[data-testid="message-selection-openLink"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="message-action-copy-resource-url"]')).toBeNull()
    expect(document.querySelector('[data-testid="message-action-send-resource-url"]')).toBeNull()
    await clickElement(document.querySelector('[data-testid="message-selection-copyLink"]')!)
    expect(writeText).toHaveBeenLastCalledWith('https://example.com/path?copy=1025')
  })
  it('keeps a file message\'s menu to message actions: its gugu URL lives on the file (preview, group files), not here', async () => {
    // Control (the parent commit 1b055755): the pair sat between 「复制」 and 「转发」 here (owner, #560: the bubble menu grows too long).
    await renderMessage(undefined, true, vi.fn(), { content: '[附件] notes.txt (text/plain)\n[Size] 12\n[Kind] file', file: { id: '12345678-1234-1234-1234-123456789abc', version: 3 } })
    await longPress()
    expect(document.querySelector('[data-testid="message-action-forward"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="message-action-copy-resource-url"]')).toBeNull()
    expect(document.querySelector('[data-testid="message-action-send-resource-url"]')).toBeNull()
  })
  it('opens a link through its existing anchor action', async () => {
    await renderMessage(undefined, true, vi.fn(), { content: 'before https://example.com/path after' })
    const link = messageBubble().querySelector('a')!
    const open = vi.spyOn(link, 'click').mockImplementation(() => {})
    await selectPhoneLink(link)
    await clickElement(document.querySelector('[data-testid="message-selection-openLink"]')!)
    expect(open).toHaveBeenCalledOnce()
  })
  it('does not offer link actions for an ordinary message press', async () => {
    await renderMessage()
    await longPress()
    expect(document.querySelector('[data-testid="message-action-copyLink"]')).toBeNull()
    expect(document.querySelector('[data-testid="message-action-openLink"]')).toBeNull()
  })
  it('replies from the desktop context menu through the existing quote action', async () => {
    const onQuote = vi.fn()
    await renderMessage(undefined, false, vi.fn(), { onQuote })
    await contextMenu()
    await clickElement(menuItem('回复'))
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-1', content: 'hello from mobile' }))
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
  it('keeps frequency-ordered mobile reactions and calls the existing reaction action', async () => {
    localStorage.setItem('gugu.reaction-frequency', JSON.stringify({ '🚀': 9, '👀': 3 }))
    const onReaction = vi.fn()
    await renderMessage(undefined, true, onReaction)
    await longPress()
    const group = document.querySelector('[role="group"][aria-label="快速回应"]')!
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(buttons.map((button) => button.textContent)).toEqual(['🚀', '👀', '👍', '❤️', '😂', '✅', ''])
    await clickElement(buttons[0])
    expect(onReaction).toHaveBeenCalledWith('msg-1', '🚀')
    expect(JSON.parse(localStorage.getItem('gugu.reaction-frequency')!)['🚀']).toBe(10)
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
  it('copies the captured message selection after menu focus clears the DOM selection', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await renderMessage(undefined, false)
    selectMessageText('hello')
    await contextMenu()
    window.getSelection()!.removeAllRanges()
    await clickElement(menuItem('复制文本'))
    expect(writeText).toHaveBeenCalledWith('hello')
  })
  it('quotes a captured excerpt with the original message identity', async () => {
    const onQuote = vi.fn()
    await renderMessage(undefined, false, vi.fn(), { onQuote })
    selectMessageText('hello')
    await contextMenu()
    window.getSelection()!.removeAllRanges()
    await clickElement(menuItem('引用选中文字'))
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-1', content: 'hello' }), { originalContent: 'hello from mobile' })
  })
  it('ignores a selection outside the message and retains whole-message copying', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await renderMessage(undefined, false)
    const outside = document.createTextNode('unrelated selection')
    document.body.append(outside)
    const range = document.createRange()
    range.selectNodeContents(outside)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    await contextMenu()
    expect([...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === '引用选中文字')).toBe(false)
    await clickElement(menuItem('复制文本'))
    expect(writeText).toHaveBeenCalledWith('hello from mobile')
    outside.remove()
  })
  it('opens the existing message actions menu on touch long press', async () => {
    await renderMessage()
    await longPress()
    expect(document.body.textContent).toContain('复制')
    expect(document.body.textContent).toContain('转发')
    expect(document.body.textContent).toContain('删除')
  })
  it('cancels the long press when touch movement becomes a scroll gesture', async () => {
    await renderMessage()
    const bubble = messageBubble()
    await act(async () => {
      bubble.dispatchEvent(touchPointerEvent('pointerdown', { clientX: 120, clientY: 240 }))
      bubble.dispatchEvent(touchPointerEvent('pointermove', { clientX: 120, clientY: 270 }))
      vi.advanceTimersByTime(550)
    })
    expect(document.body.textContent).not.toContain('复制')
    expect(document.body.textContent).not.toContain('转发')
    expect(document.body.textContent).not.toContain('删除')
  })
  it('still closes from the shared close event after a touch long press', async () => {
    await renderMessage()
    await longPress()
    expect(document.body.textContent).toContain('复制')
    await act(async () => {
      document.dispatchEvent(new CustomEvent(UI_EVENTS.closeContextMenus))
    })
    expect(document.body.textContent).not.toContain('复制')
  })
  it('uses the compact mobile message type without changing sender metadata size', async () => {
    await renderMessage()
    const bubble = messageBubble()
    const sender = harness.container.querySelector('[data-message-sender-name="true"]') as HTMLElement | null
    const bubbleColumn = bubble.closest('[data-message-bubble-column="true"]') as HTMLElement | null
    // #7333 气泡正文是「消息与长段正文」那一档(16/24,用户 2026-10-17 裁决),桌面与手机同一档(≥ #1787 的移动 14 下限)。
    expect(bubble.style.fontSize).toBe('var(--font-prose)')
    expect(bubble.style.lineHeight).toBe('var(--lh-prose)')
    const tokensCss = readFileSync('apps/desktop/src/styles/tokens.css', 'utf8')
    expect(tokensCss).toMatch(/--font-prose:\s*var\(--font-size-md\)/)
    expect(tokensCss).toMatch(/--font-size-md:\s*16px/)
    expect(tokensCss).toMatch(/--lh-prose:\s*24px/)
    expect(bubbleColumn?.style.maxWidth).toBe('78%')
    // 名字在气泡第一行,比正文小一号(14/20);时间是标注那一档(12/18)。
    expect(bubble.contains(sender), 'the sender name sits inside the bubble').toBe(true)
    expect(sender?.classList.contains('msg-sender')).toBe(true)
    const chromeCss = readFileSync('apps/desktop/src/components/chat/messageBubbleChrome.css', 'utf8')
    expect(chromeCss).toMatch(/\.msg-sender \{[^}]*font-size: var\(--font-body\)/)
    expect(chromeCss).toMatch(/\.msg-time \{[^}]*font-size: var\(--font-caption\)/)
    expect(tokensCss).toMatch(/--font-body:\s*var\(--font-size-sm\)/)
  })
  it('labels another user\'s agent, missing ownership, and my agent distinctly', async () => {
    const externalAgent = agentProfile({ ownerUserId: 'owner-2', ownerDisplayName: 'Alice' })
    await renderMessage(undefined, false, vi.fn(), { memberProfile: externalAgent })
    expect(harness.container.querySelector('[data-message-agent-owner="true"]')?.textContent).toBe('Alice 的 agent')

    await renderMessage(undefined, false, vi.fn(), { memberProfile: agentProfile({ ownerUserId: 'owner-2', ownerDisplayName: null }) })
    expect(harness.container.querySelector('[data-message-agent-owner="true"]')?.textContent).toBe('主人信息不可用')

    await renderMessage(undefined, false, vi.fn(), { memberProfile: agentProfile({ ownerUserId: 'user-1', ownerDisplayName: 'User' }) })
    expect(harness.container.querySelector('[data-message-agent-owner="true"]')?.textContent).toBe('我的 agent')
  })
  it('#6791 keeps a long sender line inside its column: the name truncates, the ownership tag stays', async () => {
    await renderMessage(undefined, true, vi.fn(), { memberProfile: agentProfile({ ownerUserId: 'user-1', ownerDisplayName: 'User' }) })
    const sender = harness.container.querySelector('[data-message-sender-name="true"]') as HTMLElement
    const [name, owner] = Array.from(sender.children) as HTMLElement[]
    expect(name.classList.contains('msg-sender-name')).toBe(true)
    expect(owner.dataset.messageAgentOwner).toBe('true')
    const chromeCss = readFileSync('apps/desktop/src/components/chat/messageBubbleChrome.css', 'utf8')
    expect(chromeCss, 'the row is capped by its column; uncapped, nowrap text pushes it past the column').toMatch(/\.msg-sender \{[^}]*max-width: 100%/)
    expect(chromeCss).toMatch(/\.msg-sender-name \{[^}]*text-overflow: ellipsis/)
    expect(chromeCss, 'the name gives way first').toMatch(/\.msg-sender > \.gg-chip \{[^}]*flex-shrink: 0/)
  })
  it('overlays the mobile read receipt without shrinking the sender bubble', async () => {
    await renderMessage(undefined, true, vi.fn(), {
      isMine: true,
      readReceiptRead: 1,
      readReceiptTotal: 1,
      showReadReceipt: true,
    })
    const receipt = harness.container.querySelector('[data-testid="message-read-receipt"]') as HTMLElement | null
    const bubble = messageBubble()
    const innerRow = bubble.parentElement as HTMLElement | null
    expect(receipt?.style.position).toBe('absolute')
    // 浮层锚在气泡那一行上(不是整列),贴着气泡左侧 —— 原先 left:-14px 钉在整列最左边,离短气泡半个屏幕
    expect(receipt?.style.right).toBe('100%')
    expect(receipt?.style.left).toBe('')
    expect(innerRow?.style.position).toBe('relative')
    expect(innerRow?.style.width).toBe('fit-content')
    expect(innerRow?.style.justifyContent).toBe('flex-end')
    expect(innerRow?.style.gap).toBe('4px')
  })
  // @@@mobile-select-guard (#1227) — 触屏 long-press 已是菜单入口，必须禁原生文本选中/callout
  it('disables native text selection + callout on compact mobile (long-press is the menu)', async () => {
    await renderMessage()
    const bubble = messageBubble()
    expect(bubble.style.userSelect).toBe('none')
    expect(bubble.style.getPropertyValue('-webkit-user-select')).toBe('none')
  })
  it('exposes quick reactions as a labelled toolbar with arrow-key navigation', async () => {
    localStorage.setItem('emoji-mart.frequently', '{"rocket":100}')
    localStorage.setItem('emoji-mart.last', 'rocket')
    const onReaction = vi.fn()
    await renderMessage(undefined, false, onReaction)
    const over = new MouseEvent('pointerover', { bubbles: true })
    Object.defineProperty(over, 'pointerType', { value: 'mouse' })
    const row = messageBubble().closest('[data-message-bubble-row]')!
    await act(async () => { row.dispatchEvent(over); row.dispatchEvent(new MouseEvent('mouseenter')) })
    await act(async () => { vi.advanceTimersByTime(TOOLTIP_OPEN_DELAY_MS) })
    const trigger = document.querySelector('button[title="表情回应"]') as HTMLButtonElement
    await clickElement(trigger)
    const toolbar = document.body.querySelector('[role="toolbar"][aria-label="快速回应"]') as HTMLElement | null
    const buttons = Array.from(toolbar?.querySelectorAll('button') ?? []) as HTMLButtonElement[]
    expect(toolbar).not.toBeNull()
    // 旧库记录不迁移,按目录里的混合快捷顺序补齐,最后一项展开精选回应。
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(
      [...QUICK_REACTIONS.map(({ emoji, zh }) => `回应 ${emoji} ${zh}`), '更多表情'],
    )
    expect(buttons.map((button) => button.getAttribute('title'))).toEqual([...QUICK_REACTIONS.map(({ zh }) => zh), null])
    buttons[0].focus()
    await act(async () => {
      buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(document.activeElement).toBe(buttons[1])
    await clickElement(buttons[1])
    expect(onReaction).toHaveBeenCalledWith('msg-1', '❤️')
    expect(localStorage.getItem('emoji-mart.frequently')).toBeNull()
    expect(localStorage.getItem('emoji-mart.last')).toBeNull()
    expect(document.body.querySelector('[role="toolbar"][aria-label="快速回应"]')).toBeNull()
  })
  it('mobile long press opens one menu by the bubble (no bottom sheet): reactions, reply first, then the shared actions', async () => {
    const onReaction = vi.fn(); const onQuote = vi.fn()
    await renderMessage(undefined, true, onReaction, { onQuote })
    await longPress()
    expect(document.body.querySelectorAll('[role="menu"]')).toHaveLength(1)
    expect(document.body.querySelector('[data-slot="sheet-content"]'), 'owner 10-26:❌ 底部抽屉').toBeNull()
    const menu = document.body.querySelector('[data-testid="message-action-menu"]') as HTMLElement
    const rows = [...menu.querySelectorAll('[data-testid^="message-action-"]')].map((el) => el.getAttribute('data-testid'))
    expect(rows).toEqual(['message-action-reply', 'message-action-copy', 'message-action-selectText', 'message-action-forward', 'message-action-delete'])
    await clickElement(menu.querySelector('[data-testid="message-action-reply"]') as HTMLElement)
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-1' }))
    expect(document.body.querySelector('[role="menu"]')).toBeNull()

    await longPress()
    const quick = [...document.body.querySelectorAll<HTMLElement>('[data-testid="message-action-menu"] [role="group"][aria-label="快速回应"] [role="menuitem"]')]
    expect(quick.map((b) => b.textContent)).toEqual([...QUICK_REACTIONS.map(({ emoji }) => emoji), ''])
    await clickElement(quick[1])
    expect(onReaction).toHaveBeenCalledWith('msg-1', '❤️')
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
  })
  it('uses saved emoji frequencies and fills the quick row from the catalog', async () => {
    localStorage.setItem('gugu.reaction-frequency', JSON.stringify({ '🚀': 9, '👀': 3, '🦄': 100 }))
    const onReaction = vi.fn()
    await renderMessage(undefined, true, onReaction)
    await longPress()
    const buttons = document.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="快速回应"] [role="menuitem"]')
    expect([...buttons].map((b) => b.textContent)).toEqual(['🚀', '👀', '👍', '❤️', '😂', '✅', ''])
    await clickElement(buttons[0])
    expect(JSON.parse(localStorage.getItem('gugu.reaction-frequency')!)['🚀']).toBe(10)
    expect(onReaction).toHaveBeenCalledWith('msg-1', '🚀')
  })
  it('expands inside the same mobile menu and keeps all named work statuses reachable', async () => {
    const onReaction = vi.fn()
    await renderMessage(undefined, true, onReaction)
    await longPress()
    await act(() => {
      flushSync(() => { (document.querySelector('button[aria-label="更多表情"]') as HTMLButtonElement).click() })
      expect(document.querySelectorAll('section[aria-label="表态"] button')).toHaveLength(24)
    })
    const sheet = document.querySelector('[data-testid="message-action-menu"]')!
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
    expect(sheet.querySelector('[role="group"][aria-label="快速回应"]')).toBeNull()
    expect(sheet.querySelector('[data-testid="message-action-reply"]')).toBeNull()
    expect(sheet.querySelector('input')).toBeNull()
    expect([...sheet.querySelectorAll('section[aria-label="表态"] button')].map((button) => button.textContent)).toEqual(REACTIONS.filter(({ kind }) => kind === 'mood').map(({ emoji }) => emoji))
    const statuses = sheet.querySelectorAll<HTMLButtonElement>('section[aria-label="工作状态"] button')
    expect([...statuses].map((b) => b.textContent)).toEqual(['👌收到', '👀在看', '⏳稍等', '✅完成', '❓疑问', '❌不对'])
    await clickElement(statuses[3])
    expect(JSON.parse(localStorage.getItem('gugu.reaction-frequency')!)).toEqual({ '✅': 1 })
    expect(onReaction).toHaveBeenCalledWith('msg-1', '✅')
    await longPress()
    expect(document.querySelector('[role="group"][aria-label="快速回应"] [role="menuitem"]')?.textContent).toBe('✅')
  })
  it('the Android back key closes the long-press menu before the page underneath can go back', async () => {
    await renderMessage()
    await longPress()
    expect(document.body.querySelector('[data-testid="message-action-menu"]')).not.toBeNull()
    const nativeBack = window as Window & { __guguNativeBackHandled?: boolean }
    nativeBack.__guguNativeBackHandled = false
    await act(async () => { window.dispatchEvent(new Event(NATIVE_BACK_EVENT)) })
    expect(document.body.querySelector('[data-testid="message-action-menu"]')).toBeNull()
    expect(nativeBack.__guguNativeBackHandled, '返回键被菜单吃掉,会话页不跟着退').toBe(true)
  })
  it('the lift that ends a long press does not become a click on the menu that just opened under the finger', async () => {
    await renderMessage()
    const tapEnd = new Event('touchend', { bubbles: true, cancelable: true })
    await act(async () => { messageBubble().dispatchEvent(tapEnd) })
    expect(tapEnd.defaultPrevented, '普通点按的松手不许被吃掉').toBe(false)
    await longPress()
    const liftEnd = new Event('touchend', { bubbles: true, cancelable: true })
    await act(async () => { messageBubble().dispatchEvent(liftEnd) })
    expect(liftEnd.defaultPrevented, '长按的松手不取消 ⇒ 合成的 click 落到菜单外或某一行上').toBe(true)
    expect(document.body.querySelector('[data-testid="message-action-menu"]')).not.toBeNull()
  })
  it.each(['context', 'more'])('keeps desktop %s menus action-only while retaining the hover reaction entry', async (entry) => {
    const onQuote = vi.fn()
    await renderMessage(undefined, false, vi.fn(), { onQuote })
    const row = messageBubble().closest('[data-message-bubble-row]')!
    const over = new MouseEvent('pointerover', { bubbles: true })
    Object.defineProperty(over, 'pointerType', { value: 'mouse' })
    await act(async () => { row.dispatchEvent(over); row.dispatchEvent(new MouseEvent('mouseenter')); vi.advanceTimersByTime(TOOLTIP_OPEN_DELAY_MS) })
    expect(document.querySelector('button[title="表情回应"]')).not.toBeNull()
    if (entry === 'more') await clickElement(document.querySelector('[data-testid="message-hover-actions"] button[aria-label="更多"]')!)
    else await contextMenu()
    expect(document.querySelector('[data-testid="message-action-selectText"]')).toBeNull()
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
    expect(document.querySelector('[aria-label="快速回应"]')).toBeNull()
    expect(document.querySelector('[aria-label="更多表情"]')).toBeNull()
    expect([...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim())).toEqual(['回复', '复制文本', '转发', '删除'])
    await clickElement(menuItem('回复'))
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-1' }))
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
  it('expands More inside the mobile menu without dismissing it or opening another surface', async () => {
    await renderMessage(undefined, true)
    await longPress()
    await clickElement(document.querySelector('[aria-label="更多表情"]') as HTMLElement)
    await act(async () => { await vi.dynamicImportSettled() })
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
    expect(document.querySelector('[role="group"][aria-label="快速回应"]')).toBeNull()
    expect(document.querySelectorAll('section[aria-label="工作状态"] button')).toHaveLength(6)
  })
  // @@@copy-fail-loud (#1123) — clipboard 复制必须 await + 反馈，失败不静默。
  async function openMenuAndCopy() {
    await longPress()
    const copyItem = [...document.body.querySelectorAll('*')]
      .find((el) => el.textContent?.trim() === '复制文本') as HTMLElement | undefined
    expect(copyItem, 'copy-text menu item should be present').toBeTruthy()
    await act(async () => {
      copyItem!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
  }
  it('copy text success → 已复制 toast (#1123)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const toast = vi.fn()
    await renderMessage(toast)
    await openMenuAndCopy()
    expect(writeText).toHaveBeenCalledWith('hello from mobile')
    expect(toast).toHaveBeenCalledWith('已复制', 'success')
  })
  it('copy text clipboard reject → fail-loud toast, not silent (#1123)', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard denied /Users/test/private sk-synthetic-secret\nstack detail'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const toast = vi.fn()
    await renderMessage(toast)
    await openMenuAndCopy()
    expect(toast).toHaveBeenCalledWith('复制失败', 'error', 'clipboard denied [path] [redacted token]')
  })
  it('exposes working copy, quote and more actions below a private agent answer without hovering', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const toast = vi.fn(), onQuote = vi.fn()
    await renderMessage(toast, false, vi.fn(), { isAgent: true, isGroup: false, onQuote })
    const bar = harness.container.querySelector('[data-testid="agent-answer-actions"]')!
    const buttons = [...bar.querySelectorAll('button')]
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(['复制文本', '回复', '更多'])
    await clickElement(buttons[0])
    expect(writeText).toHaveBeenCalledWith('hello from mobile')
    expect(toast).toHaveBeenCalledWith('已复制', 'success')
    await clickElement(buttons[1])
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-1' }))
    await clickElement(buttons[2])
    expect(document.body.textContent).toContain('转发')
    await renderMessage(toast, false, vi.fn(), { isAgent: true, isGroup: true })
    expect(harness.container.querySelector('[data-testid="agent-answer-actions"]')).toBeNull()
  })
})
async function renderMessage(
  toast?: (message: string, type?: ToastType) => void,
  compactMobile = true,
  onReaction = vi.fn(),
  options: {
    content?: string
    file?: { id: string; version: number }
    isMine?: boolean
    isAgent?: boolean
    isGroup?: boolean
    readReceiptRead?: number
    readReceiptTotal?: number
    showReadReceipt?: boolean
    memberProfile?: MemberProfileCardModel
    onQuote?: (msg: unknown) => void
  } = {},
) {
  const isMine = options.isMine ?? false
  await renderWithAppProviders(
    harness,
    createNode(MessageBubble, {
      msg: message({
        id: 'msg-1',
        content: options.content ?? 'hello from mobile',
        ...(options.file ? { content_type: 'attachment', file_item_id: options.file.id, file_version: options.file.version } as const : {}),
        is_mine: isMine,
        sender_user_id: 'sender-1',
        created_at: '2026-05-24T00:00:00.000Z',
      }),
      onReaction,
      memberReadSeqs: {},
      onQuote: options.onQuote ?? vi.fn(),
      onForward: vi.fn(),
      onDelete: vi.fn(),
      compactMobile,
      readReceiptRead: options.readReceiptRead,
      readReceiptTotal: options.readReceiptTotal,
      showReadReceipt: options.showReadReceipt,
      memberProfile: options.memberProfile,
      // @@@1484 发送者名仅群聊显示 → 本用例验「名字渲染时的尺寸/颜色」,以群聊语境渲染。
      isGroup: options.isGroup ?? true,
      isAgent: options.isAgent,
    }),
    toast ? { toast } : undefined,
  )
}
async function longPress(target = messageBubble()) {
  await act(async () => {
    target.dispatchEvent(touchPointerEvent('pointerdown', { clientX: 120, clientY: 240 }))
    vi.advanceTimersByTime(550)
  })
  await act(async () => { await vi.dynamicImportSettled() })
}
async function contextMenu() {
  await act(async () => {
    messageBubble().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 240 }))
  })
  await act(async () => { await vi.dynamicImportSettled() })
}
function menuItem(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent === label)
  expect(item).toBeDefined()
  return item!
}
function selectMessageText(text: string) {
  selectTextIn(messageBubble().querySelector('p')!, text)
}
function selectTextIn(element: Element, text: string) {
  const node = element.firstChild!
  const start = node.textContent!.indexOf(text)
  expect(start).toBeGreaterThanOrEqual(0)
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, start + text.length)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
}
function agentProfile(overrides: Partial<MemberProfileCardModel> = {}): MemberProfileCardModel {
  return {
    id: 'sender-1', displayName: 'Claude', avatar: null, email: null, bio: null,
    type: 'agent', role: 'member', profileScope: 'group', ...overrides,
  }
}
function messageBubble() {
  const bubble = harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.messageBubbleActionTarget}"]`) as HTMLElement | null
  expect(bubble).not.toBeNull()
  return bubble!
}
function touchPointerEvent(type: string, init: { clientX: number; clientY: number }) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
  }) as MouseEvent & { pointerType?: string; pointerId?: number; isPrimary?: boolean }
  Object.defineProperty(event, 'pointerType', { value: 'touch' })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  Object.defineProperty(event, 'isPrimary', { value: true })
  return event
}

async function selectPhoneLink(link: HTMLAnchorElement) {
  await longPress(link)
  await act(async () => {
    const range = document.createRange(); range.selectNodeContents(link)
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    document.dispatchEvent(new Event('touchend'))
  })
}
