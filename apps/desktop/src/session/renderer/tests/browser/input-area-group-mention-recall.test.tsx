import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { until } from '../../../../../../../tests/support/awaitCondition'

let root: Root
let host: HTMLDivElement
const onSend = vi.fn(async (_content: string, _options?: { toUserIds?: string[] | null }) => {})
beforeEach(async () => {
  setLocalePreference('en-US')
  localStorage.removeItem('gugu:group-mention:recall-account/recall-room')
  onSend.mockClear()
  host = document.createElement('div')
  host.style.cssText = 'position:absolute;left:24px;top:180px;width:min(640px, calc(100vw - 48px))'
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { root.unmount(); host.remove(); localStorage.removeItem('gugu:group-mention:recall-account/recall-room') })

it.each([
  { width: 1000, accept: 'ArrowRight' },
  { width: 1000, accept: 'Tab' },
])('reuses the actual member picker token via $accept at $width px', async ({ width, accept }) => {
  await page.viewport(width, 720)
  root.render(<LocalizationProvider><ChatMessageComposer chatId="recall-room" currentUserId="recall-account" isGroupChat onSend={onSend}
    groupMembers={[{ id: 'recall-agent', name: 'Recall agent', type: 'agent' }]} /></LocalizationProvider>)
  const input = page.getByTestId('chat-composer')
  await until('real editor is mounted', () => input.elements().length === 1)
  await input.click()
  await userEvent.keyboard('@')
  const member = page.getByRole('option', { name: /Recall agent/ })
  await until('real member picker result', () => member.elements().length === 1)
  await member.click()
  await until('manual member token inserted', () => input.element().querySelector('[data-mention-id="recall-agent"]') !== null)
  const manual = input.element().querySelector('[data-mention-id="recall-agent"]')!.textContent
  const send = page.getByRole('button', { name: 'Send message', exact: true })
  await send.click()
  const hint = page.getByTestId('group-mention-hint')
  await until('empty editor recalls the sent target', () => hint.elements().length === 1)
  expect(send.element().hasAttribute('disabled')).toBe(true)
  expect(input.element().textContent).toBe('')
  const rect = hint.element().getBoundingClientRect()
  const area = host.querySelector('[data-slot="composer-input"]')!.getBoundingClientRect()
  expect(rect.width).toBeGreaterThan(0)
  expect(rect.left).toBeGreaterThanOrEqual(area.left)
  expect(rect.right).toBeLessThanOrEqual(area.right)
  expect(rect.top).toBeGreaterThanOrEqual(area.top)
  expect(hint.element().querySelector('kbd svg')).not.toBeNull()
  await input.click(); await userEvent.keyboard(`{${accept}}`)
  await until('recalled member token inserted', () => input.element().querySelector('[data-mention-id="recall-agent"]') !== null)
  expect(input.element().querySelector('[data-mention-id="recall-agent"]')!.textContent).toBe(manual)
  expect(onSend).toHaveBeenCalledTimes(1)
  await send.click()
  expect(onSend).toHaveBeenCalledTimes(2)
  expect(onSend.mock.calls[1]?.[0]).toBe(onSend.mock.calls[0]?.[0])
  expect(onSend.mock.calls[1]?.[1]?.toUserIds).toEqual(['recall-agent'])
})

it('shows and records no recall on the phone shell', async () => {
  await page.viewport(390, 720)
  root.render(<LocalizationProvider><ChatMessageComposer chatId="recall-room" currentUserId="recall-account" isGroupChat onSend={onSend}
    groupMembers={[{ id: 'recall-agent', name: 'Recall agent', type: 'agent' }]} /></LocalizationProvider>)
  const input = page.getByTestId('chat-composer')
  await until('real editor is mounted', () => input.elements().length === 1)
  await input.click()
  await userEvent.keyboard('@')
  const member = page.getByRole('option', { name: /Recall agent/ })
  await until('real member picker result', () => member.elements().length === 1)
  await member.click()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await until('sent to the picked agent', () => onSend.mock.calls.length === 1)
  expect(onSend.mock.calls[0]?.[1]?.toUserIds).toEqual(['recall-agent'])
  expect(localStorage.getItem('gugu:group-mention:recall-account/recall-room')).toBeNull()
  expect(page.getByTestId('group-mention-hint').elements()).toHaveLength(0)
})
