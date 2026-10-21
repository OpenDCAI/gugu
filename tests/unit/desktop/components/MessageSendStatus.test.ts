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
      createNode(MessageSendStatus, { state: 'failed', messageId: 'message-1' }),
      { chat: { retrySend, discardSend } },
    )
    const trigger = document.body.querySelector('[data-testid="message-send-failed"]') as HTMLElement
    await clickElement(trigger)
    expect(document.body.querySelector('[role="menu"][aria-label="未送达消息操作"]')).not.toBeNull()
    const retry = document.body.querySelector('[data-testid="message-send-retry"]') as HTMLElement
    await clickElement(retry)
    expect(retrySend).toHaveBeenCalledWith('message-1')
    expect(document.body.querySelector('[data-testid="message-send-failed-menu"]')).toBeNull()
    await clickElement(trigger)
    const discard = document.body.querySelector('[data-testid="message-send-discard"]') as HTMLElement
    await clickElement(discard)
    expect(discardSend).toHaveBeenCalledWith('message-1')
  })
})
