/**
 * #6722 群聊 @ 候选的真浏览器滚动合同。
 *
 * jsdom 没有布局，mock scrollIntoView 只能证明调用发生，证明不了活动项真的进入 max-height
 * 弹层视口。这条在 Chromium 里量 scrollHeight / bounding box，并把鼠标停在弹层中部，防止
 * 程序化滚动触发 hover 后篡改键盘高亮。
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import type { GroupRosterCandidate } from '@/lib/mention'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'

const members: GroupRosterCandidate[] = Array.from({ length: 12 }, (_, index) => ({
  id: `agent-${index}`,
  name: `Agent ${index}`,
  type: 'agent',
}))

let root: Root | null = null
let host: HTMLDivElement | null = null

const picker = () => document.querySelector<HTMLElement>('[data-slot="composer-menu"][role="listbox"]')
const options = () => Array.from(picker()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
const activeOption = () => picker()?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ?? null
const isInsidePicker = (option: HTMLElement, list: HTMLElement): boolean => {
  const optionRect = option.getBoundingClientRect()
  const listRect = list.getBoundingClientRect()
  return optionRect.top >= listRect.top - 0.5 && optionRect.bottom <= listRect.bottom + 0.5
}

function render(): void {
  host = document.createElement('div')
  host.style.cssText = 'position:absolute;left:130px;top:340px;width:640px;padding:24px;background:var(--bg);font-family:Arial,sans-serif'
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <LocalizationProvider>
      <ChatMessageComposer
        onSend={vi.fn(async () => {})}
        isGroupChat
        groupMembers={members}
      />
    </LocalizationProvider>,
  )
}

describe('#6722 @ mention keyboard scroll', () => {
  beforeEach(async () => {
    await page.viewport(900, 720)
    document.documentElement.dataset.theme = 'light'
    document.body.style.margin = '0'
    setLocalePreference('zh-CN')
    render()
  })

  afterEach(() => {
    root?.unmount()
    host?.remove()
    root = null
    host = null
  })

  it('ArrowDown / ArrowUp keep the last candidate visible and Enter selects it', async () => {
    const textarea = page.getByTestId('chat-composer')
    await textarea.click()
    await userEvent.keyboard('@')
    await until('mention picker contains every candidate', () => options().length === 13)

    const list = picker()!.querySelector('ul')!
    const rows = options()
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight)
    expect(isInsidePicker(rows.at(-1)!, list), 'last row must start outside the first popup viewport').toBe(false)

    // 把鼠标停在首屏中部。程序化滚动若仍由 mouseenter 接管高亮，这条会选错人。
    await page.getByRole('option', { name: /Agent 2/ }).hover()
    await until('hover selects Agent 2', () => activeOption()?.textContent?.includes('Agent 2') === true)

    for (let index = 0; index < 10; index += 1) await userEvent.keyboard('{ArrowDown}')
    await until('keyboard reaches the last candidate', () => activeOption() === rows.at(-1))
    expect(list.scrollTop).toBeGreaterThan(0)
    expect(isInsidePicker(rows.at(-1)!, list)).toBe(true)

    await userEvent.keyboard('{ArrowDown}')
    await until('ArrowDown wraps to the first candidate', () => activeOption() === rows[0])
    expect(isInsidePicker(rows[0], list)).toBe(true)

    await userEvent.keyboard('{ArrowUp}')
    await until('ArrowUp wraps back to the last candidate', () => activeOption() === rows.at(-1))
    expect(isInsidePicker(rows.at(-1)!, list)).toBe(true)
    await page.screenshot({ path: 'input-area-mention-scroll-6722.png' })

    await userEvent.keyboard('{Enter}')
    await until('Enter accepts the visible last candidate', () => textarea.element().querySelector('[data-mention-id="*"]') !== null)
  })

  it('anchors the shared popup at the typed @ character', async () => {
    const input = page.getByTestId('chat-composer')
    await input.click()
    await userEvent.keyboard('hello there @')
    await until('the shared mention popup opens', () => options().length === 13)
    const node = input.element().querySelector('.suggestion')!
    expect(node.textContent).toBe('@')
    const range = document.createRange()
    range.selectNodeContents(node)
    const caret = range.getBoundingClientRect()
    expect(caret.left).toBeGreaterThan(input.element().getBoundingClientRect().left + 40)
    await until('popup follows the typed caret', () => Math.abs(picker()!.getBoundingClientRect().left - caret.left) < 2)
  })

})
