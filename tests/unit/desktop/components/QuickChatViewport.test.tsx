// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { QuickChat } from '../../../../apps/desktop/src/components/assistant/QuickChat'
import { chatWindowStub } from '../../../support/chatWindowStub'
import { clickElement, createNode, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => harness?.cleanup())
describe('Quick chat viewport lifetime', () => {
  it('uses the same counted and recovered failure card with its normal providers', async () => {
    harness = createReactHarness()
    const windows = chatWindowStub()
    const failure = (id: string, seq: number) => message({ id, chat_id: 'quick', seq, sender_user_id: 'agent',
      content_type: 'system', content: 'host-only diagnostic', client_message_id: `turn-failure:${id}:network` })
    windows.write('quick', () => [failure('failure-a', 1), failure('failure-b', 2)])
    await renderWithAppProviders(harness, createNode(QuickChat, {
      assistant: { id: 'agent', display_name: 'Helper', avatar: null }, assistantState: 'found', chatId: 'quick', chatFailed: null,
      retryChat: () => {}, visible: true, shortcut: 'test', onClose: () => {}, onOpenMain: () => {},
    }), { chat: { conversations: windows.conversations } })
    expect(harness.container.querySelectorAll('.tfc')).toHaveLength(1)
    expect(harness.container.querySelector('.tfc-count')?.textContent).toBe('×2')
    expect(harness.container.querySelector('[data-testid="agent-turn-failure-retry"]')).toBeNull()
    await act(async () => windows.write('quick', rows => [...rows, message({ id: 'reply', chat_id: 'quick', seq: 3, sender_user_id: 'agent', content: 'recovered' })]))
    expect(harness.container.querySelector('.tfc')).toBeNull()
    const summary = harness.container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!
    expect(summary).not.toBeNull()
    await clickElement(summary)
    expect(harness.container.querySelector('.tfc-count')?.textContent).toBe('×2')
    expect(harness.container.textContent).not.toContain('host-only diagnostic')
  })
  it('shows the current tail after more than a window arrives while the native host is hidden', async () => {
    harness = createReactHarness()
    const windows = chatWindowStub()
    const row = (seq: number) => message({ id: `quick-${seq}`, chat_id: 'quick', seq, content: `arriving ${seq}` })
    windows.write('quick', () => [row(1)])
    const render = (visible: boolean) => renderWithAppProviders(harness!, createNode(QuickChat, {
      assistant: null, assistantState: 'found', chatId: 'quick', chatFailed: null, retryChat: () => {},
      visible, shortcut: 'test', onClose: () => {}, onOpenMain: () => {},
    }), { chat: { conversations: windows.conversations } })
    await render(true)
    expect(harness.container.querySelector('[data-testid="quick-chat"]')?.hasAttribute('inert')).toBe(false)
    const input = harness.container.querySelector<HTMLTextAreaElement>('[data-testid="quick-chat-input"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'unfinished draft')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(harness.container.querySelector<HTMLButtonElement>('[data-testid="quick-chat-send"]')?.disabled).toBe(false)
    await render(false)
    expect(harness.container.querySelector('[data-testid="quick-chat"]')?.hasAttribute('inert')).toBe(true)
    await act(async () => { for (let seq = 2; seq <= 180; seq++) windows.write('quick', (rows) => [...rows, row(seq)]) })
    await render(true)
    expect(harness.container.querySelector('[data-testid="quick-chat"]')?.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(harness.container.querySelector('[data-testid="quick-chat-input"]'))
    expect(input.value).toBe('unfinished draft')
    const rows = harness.container.querySelectorAll('[data-testid^="quick-chat-message-"]')
    expect(rows).toHaveLength(40)
    expect(rows[0]?.getAttribute('data-testid')).toBe('quick-chat-message-quick-141')
    expect(rows[39]?.getAttribute('data-testid')).toBe('quick-chat-message-quick-180')
  })
})
