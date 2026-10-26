// @vitest-environment jsdom
// What a chat's tab shows is drawn by the shell into a slot the strip's engine leaves for it, only while the tab is on
// screen. The slot follows the strip as it changes after mount — the first build drew a slot only for tabs already on
// screen when the content mounted (its slots were not an observer), so a block opened before its folder stayed empty.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { installShellSlots } from '../../../../apps/desktop/src/lib/shellSlots'
import { folderItem } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-panel-item'
import { chatLayoutOf, closeChatTab, openPanelItem, showChatOnly } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts'
import { chatPanelTabProvider } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-tab-providers'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  installShellSlots()
  harness = createReactHarness()
})
afterEach(() => harness.cleanup())

const slots = () => [...harness.container.querySelectorAll('[data-chat-tab-slot]')].map((element) => element.getAttribute('data-chat-tab-slot'))

describe('the slots of a chat\'s panel tabs', () => {
  it('appear for a tab opened after the content mounted, follow the one on screen, and go with it', async () => {
    const chatId = 'slots-1'
    const pane = chatLayoutOf(chatId).groups[0]!.pane
    await harness.render(createElement(chatPanelTabProvider.TabContent, { host: pane, ctx: pane.ctx }))
    expect(slots(), 'nothing open: no slot').toEqual([])
    const folder = await act(async () => openPanelItem(chatId, folderItem()))
    expect(slots()).toEqual([folder])
    const board = await act(async () => openPanelItem(chatId, { kind: 'kanban.board', title: 'Board' }))
    expect(slots(), 'the board took the place beside the chat; the folder, not on screen, has none').toEqual([board])
    await act(async () => showChatOnly(chatId))
    expect(slots(), 'the chat focused, the pair still on screen').toEqual([board])
    await act(async () => closeChatTab(chatId, board!))
    expect(slots(), 'closed: the chat alone').toEqual([])
  })
})
