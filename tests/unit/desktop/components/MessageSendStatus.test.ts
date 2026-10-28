// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageSendStatus } from '../../../../apps/desktop/src/components/chat/MessageSendStatus'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
})
describe('MessageSendStatus', () => {
  it('uses the shared Base UI menu and wires retry/discard actions', async () => {
    const retrySend = vi.fn()
    const discardSend = vi.fn()
    await renderWithAppProviders(
      harness,
      createNode(MessageSendStatus, { state: 'failed', messageId: 'message-1', reason: 'Recipient left /Users/test/private sk-synthetic-secret\nstack detail' }),
      { chat: { retrySend, discardSend } },
    )
    const trigger = document.body.querySelector('[data-testid="message-send-failed"]') as HTMLElement
    expect(trigger.title).toBe('Recipient left [path] [redacted token]')
    await clickElement(trigger)
    expect(document.body.querySelector('[role="menu"][aria-label="未送达消息操作"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="message-send-failed-menu"]')?.textContent).toContain('Recipient left [path] [redacted token]')
    const retry = document.body.querySelector('[data-testid="message-send-retry"]') as HTMLElement
    await clickElement(retry)
    expect(retrySend).toHaveBeenCalledWith('message-1')
    expect(document.body.querySelector('[data-testid="message-send-failed-menu"]')).toBeNull()
    await clickElement(trigger)
    const discard = document.body.querySelector('[data-testid="message-send-discard"]') as HTMLElement
    await clickElement(discard)
    expect(discardSend).toHaveBeenCalledWith('message-1')
  })
  it('shows a message an agent has not taken yet as the same sending ring, saying it waits for the assistant', async () => {
    await renderWithAppProviders(harness, createNode(MessageSendStatus, { state: 'queued', messageId: 'message-1' }), { chat: { retrySend: vi.fn(), discardSend: vi.fn() } })
    const ring = document.body.querySelector('[data-send-state="queued"]')!
    expect(ring.getAttribute('class')).toBe('gg-ring-march')
    expect(ring.querySelector('title')?.textContent).toBe('发送中，助理就绪后回复')
  })
})
