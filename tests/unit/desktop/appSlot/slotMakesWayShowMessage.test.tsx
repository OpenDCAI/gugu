// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { APP_COMPOSE_EVENT } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

/**
 * `gugu.showMessage` from an App in a chat's slot: the chat's list goes to the message (useSourceMessageReveal), and the
 * slot gets out from over the chat so the person sees it — as after `gugu.compose`. On the phone the slot covers the chat
 * and closes (its back layer with it: back then leaves the chat); a desktop slot at full width goes back to its side form.
 * Before, nothing moved it: the call answered, and the message stayed under the panel.
 */
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ activeChatId: 'chat-1' }) }))
const { useSlotMakesWay } = await import('../../../../apps/desktop/src/components/appSlot/useSlotMakesWay')

type Slot = Parameters<typeof useSlotMakesWay>[0]
function Probe({ slot, mobile }: { slot: Slot; mobile: boolean }) {
  useSlotMakesWay(slot, mobile)
  return null
}
const show = (detail: { chatId: string; messageId: string }) => act(() => void window.dispatchEvent(new CustomEvent(APP_COMPOSE_EVENT, { detail: { chatId: detail.chatId, text: 'draft' } })))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
})
afterEach(() => harness.cleanup())

describe('the slot makes way for an App compose; reveals use their target viewport', () => {
  it('phone: the slot over the chat closes', async () => {
    const slot = { chatId: 'chat-1', full: false, onToggleFull: vi.fn(), onClose: vi.fn() }
    await harness.render(createElement(Probe, { slot, mobile: true }))
    show({ chatId: 'chat-1', messageId: 'm-1' })
    expect(slot.onClose).toHaveBeenCalledTimes(1)
    expect(slot.onToggleFull).not.toHaveBeenCalled()
  })

  it('desktop: a full-width slot goes back to its side form; one at the side stays', async () => {
    const full = { chatId: 'chat-1', full: true, onToggleFull: vi.fn(), onClose: vi.fn() }
    await harness.render(createElement(Probe, { slot: full, mobile: false }))
    show({ chatId: 'chat-1', messageId: 'm-1' })
    expect(full.onToggleFull).toHaveBeenCalledTimes(1)
    expect(full.onClose).not.toHaveBeenCalled()

    const side = { chatId: 'chat-1', full: false, onToggleFull: vi.fn(), onClose: vi.fn() }
    await harness.render(createElement(Probe, { slot: side, mobile: false }))
    show({ chatId: 'chat-1', messageId: 'm-2' })
    expect(side.onToggleFull).not.toHaveBeenCalled()
    expect(side.onClose).not.toHaveBeenCalled()
  })

  it('control: a message of another chat leaves this slot where it is', async () => {
    const slot = { chatId: 'chat-1', full: false, onToggleFull: vi.fn(), onClose: vi.fn() }
    await harness.render(createElement(Probe, { slot, mobile: true }))
    show({ chatId: 'chat-2', messageId: 'm-1' })
    expect(slot.onClose).not.toHaveBeenCalled()
  })
})
