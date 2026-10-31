// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { APP_COMPOSE_EVENT } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

/**
 * `gugu.showMessage` from an App in a chat's tab: the chat's list goes to the message (useSourceMessageReveal), and the
 * tab gets out from over the chat so the person sees it — as after `gugu.compose`. On the phone the tab covers the chat
 * and the chat comes to the front; a desktop tab filling the block goes back beside the chat.
 * Before, nothing moved it: the call answered, and the message stayed under the panel.
 */
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ activeChatId: 'chat-1', chats: [] }) }))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: { kind: 'electron', capabilities: { appUpdates: false, notifications: false, rendererCommandBridge: false } },
}))
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({
  appsHere: { runs: () => true, grantable: (manifest: unknown) => manifest, installAttachment: vi.fn(), marketOffers: vi.fn(async () => ({ success: true, data: [] })), groupFileOpener: vi.fn(), groupFilesOpenedBy: vi.fn(async () => ({ success: true, data: [] })), setOpenWithDefault: vi.fn() },
}))
vi.mock('../../../../apps/desktop/src/components/extensionBundle/sharedPackages', () => ({
  sharedPackagesOf: async () => new Map(),
  subscribeSharedPackages: () => () => {},
}))
const { useSlotMakesWay } = await import('../../../../apps/desktop/src/components/appSlot/useSlotMakesWay')
const { chatTabs } = await import('./chatTabsHarness')
const { focusedChatTab, openPanelItem, panelFull, setPanelFull } = await import('../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts')

function Probe({ chatId, makeWay }: { chatId: string; makeWay: () => void }) {
  useSlotMakesWay(chatId, makeWay)
  return null
}
const show = (chatId: string) => act(() => void window.dispatchEvent(new CustomEvent(APP_COMPOSE_EVENT, { detail: { chatId, text: 'draft' } })))
const board = { kind: 'board.main', title: 'Board' }

let harness: ReturnType<typeof createReactHarness>
const originalCheckVisibility = HTMLElement.prototype.checkVisibility
beforeEach(() => {
  harness = createReactHarness()
  HTMLElement.prototype.checkVisibility = () => false
})
afterEach(() => {
  harness.cleanup()
  HTMLElement.prototype.checkVisibility = originalCheckVisibility
})

describe('the tab makes way for an App compose', () => {
  it('its own chat makes way; another chat\'s compose does not', async () => {
    const makeWay = vi.fn()
    await harness.render(createElement(Probe, { chatId: 'chat-1', makeWay }))
    show('chat-2')
    expect(makeWay).not.toHaveBeenCalled()
    show('chat-1')
    expect(makeWay).toHaveBeenCalledTimes(1)
  })

  it('phone: the tab over the chat gives the chat the front', async () => {
    openPanelItem('way-phone', board)
    await harness.render(chatTabs({ chatId: 'way-phone', mobile: true }))
    expect(focusedChatTab('way-phone')?.kind).toBe('panel')
    show('way-phone')
    expect(focusedChatTab('way-phone')?.kind).toBe('chat')
  })

  it('desktop: a tab filling the block goes back beside the chat; one beside it stays', async () => {
    const full = openPanelItem('way-full', board)!
    setPanelFull('way-full', full, true)
    await harness.render(chatTabs({ chatId: 'way-full', tabbed: true }))
    show('way-full')
    expect(panelFull('way-full', full)).toBe(false)
    expect(focusedChatTab('way-full')?.kind).toBe('panel')

    const side = openPanelItem('way-side', board)!
    await harness.render(chatTabs({ chatId: 'way-side', tabbed: true }))
    show('way-side')
    expect(panelFull('way-side', side)).toBe(false)
    expect(focusedChatTab('way-side')?.kind).toBe('panel')
  })

  it('control: a message of another chat leaves this tab where it is', async () => {
    openPanelItem('way-other', board)
    await harness.render(chatTabs({ chatId: 'way-other', mobile: true }))
    show('chat-2')
    expect(focusedChatTab('way-other')?.kind).toBe('panel')
  })
})
