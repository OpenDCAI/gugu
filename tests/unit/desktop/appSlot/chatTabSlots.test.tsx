// @vitest-environment jsdom
// What a chat's tab shows is drawn into a stable, bounded slot in the strip's engine. The slot follows the strip after
// mount — the first build drew a slot only for tabs already on
// screen when the content mounted (its slots were not an observer), so a block opened before its folder stayed empty.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement, useState } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { installShellSlots } from '../../../../apps/desktop/src/lib/shellSlots'
import { folderItem } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-panel-item'
import { chatLayoutOf, closeChatTab, closeInfoTab, closeTopicTab, infoTabOf, openInfoTab, openPanelItem, openTopicTab, showChatOnly, showChatTab } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts'
import { chatPanelTabProvider } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-tab-providers'
import { ChatTabPage, ChatTabPortals } from '../../../../apps/desktop/src/components/appSlot/ChatTabHosts'
import { PaneContent } from '../../../../apps/desktop/src/session/renderer/features/tabs/pane-content'
import { PaneContext } from '../../../../apps/desktop/src/session/renderer/features/tabs/pane-context'
import { KEPT_HIDDEN_TABS } from '../../../../apps/desktop/src/session/renderer/features/tabs/retained-tab-content'

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
    expect(slots().sort(), 'the folder keeps its slot while the board is shown').toEqual([folder, board].sort())
    await act(async () => showChatOnly(chatId))
    expect(slots().sort(), 'the chat focused, the pair still on screen').toEqual([folder, board].sort())
    await act(async () => closeChatTab(chatId, board!))
    expect(slots(), 'the closed board releases its slot').toEqual([folder])
    await act(async () => closeChatTab(chatId, folder!))
    expect(slots()).toEqual([])
  })

  it('keeps portal drafts and both halves of a pair in place, with the same bound as task tabs', async () => {
    const chatId = 'retained-chat-portals'
    const group = chatLayoutOf(chatId).groups[0]!
    const pane = group.pane
    const folder = await act(async () => openPanelItem(chatId, folderItem()))
    await harness.render(createElement('div', null,
      createElement(PaneContext.Provider, { value: { paneId: group.paneId, pane, isFocusedPane: true } }, createElement(PaneContent, { hideTabBar: true })),
      createElement(ChatTabPortals, {
        chatId,
        panel: (tab) => createElement('textarea', { 'data-draft': tab.tabId, defaultValue: tab.item.title }),
        topic: () => createElement('textarea', { 'data-topic-draft': '', defaultValue: 'topic' }),
        info: () => createElement('textarea', { 'data-info-draft': '', defaultValue: 'info' }),
      }),
    ))
    const draft = harness.container.querySelector<HTMLTextAreaElement>(`[data-draft="${folder}"]`)!
    draft.value = 'unfinished folder draft'
    draft.scrollTop = 42
    const board = await act(async () => openPanelItem(chatId, { kind: 'kanban.board', title: 'Board' }))
    expect(harness.container.querySelector(`[data-draft="${folder}"]`)).toBe(draft)
    expect(draft.closest<HTMLElement>('[data-chat-tab-slot]')!.style.contentVisibility).toBe('hidden')
    await act(async () => showChatTab(chatId, folder!))
    expect([draft.value, draft.scrollTop]).toEqual(['unfinished folder draft', 42])
    await act(async () => { pane.separatePair(); pane.setActiveTab(folder!); pane.splitTab(board!, 'right') })
    const boardDraft = harness.container.querySelector<HTMLTextAreaElement>(`[data-draft="${board}"]`)!
    expect(harness.container.querySelectorAll(`[data-draft="${board}"]`)).toHaveLength(1)
    expect(draft.closest<HTMLElement>('[data-chat-tab-slot]')!.style.left).toBe('0px')
    expect(boardDraft.closest<HTMLElement>('[data-chat-tab-slot]')!.style.left).toBe('50%')
    await act(async () => boardDraft.focus())
    expect(pane.resolvedActiveTabId).toBe(board)
    await act(async () => pane.separatePair())
    await act(async () => openTopicTab(chatId, { topicChatId: 'retained-topic', name: 'Topic' }))
    const topicDraft = harness.container.querySelector<HTMLTextAreaElement>('[data-topic-draft]')!
    topicDraft.value = 'unfinished topic draft'
    await act(async () => openInfoTab(chatId))
    expect(harness.container.querySelector('[data-topic-draft]')).toBe(topicDraft)
    expect(topicDraft.value).toBe('unfinished topic draft')
    for (let index = 0; index < KEPT_HIDDEN_TABS + 2; index++) {
      await act(async () => openPanelItem(chatId, { kind: 'workspace.main', itemId: `file-${index}`, title: `file-${index}` }))
    }
    expect(slots()).toHaveLength(KEPT_HIDDEN_TABS + 1)
    expect(harness.container.querySelector(`[data-draft="${folder}"]`)).toBeNull()
  })
})

describe('a chat\'s phone page', () => {
  it('shows only the focused tab, including topics, before the pane has measured its size', async () => {
    const chatId = 'phone-focused-tab'
    const pane = chatLayoutOf(chatId).groups[0]!.pane
    await harness.render(createElement(ChatTabPage, {
      chatId,
      panel: (tab) => createElement('article', null, tab.item.title),
      topic: () => createElement('article', null, 'Topic'),
      info: () => null,
    }))
    expect(harness.container.textContent).toBe('')
    await act(async () => openPanelItem(chatId, { kind: 'kanban.board', title: 'Board' }))
    expect(pane.pairShown, 'unmeasured: the desktop model permits two, but the phone draws only the focused page').toBe(true)
    expect(harness.container.textContent).toBe('Board')
    await act(async () => openTopicTab(chatId, { topicChatId: 'phone-topic', name: 'Topic' }))
    expect(harness.container.textContent).toBe('Topic')
    expect(harness.container.querySelectorAll('article')).toHaveLength(1)
    await act(async () => closeTopicTab(chatId))
    expect(harness.container.textContent).not.toContain('Topic')
    await act(async () => showChatOnly(chatId))
    expect(harness.container.textContent).toBe('')
  })

  it('keeps a panel page mounted across its return chain, and closes back to the chat', async () => {
    const chatId = 'phone-return-chain'
    let mounted = 0
    function Panel({ title }: { title: string }) {
      const [instance] = useState(() => ++mounted)
      return createElement('article', null, `${title}:${instance}`)
    }
    await harness.render(createElement(ChatTabPage, {
      chatId,
      panel: (tab) => createElement(Panel, { title: tab.item.title }),
      topic: () => null,
      info: () => null,
    }))
    const board = await act(async () => openPanelItem(chatId, { kind: 'kanban.board', title: 'Board' }))
    expect(harness.container.textContent).toBe('Board:1')
    const file = await act(async () => openPanelItem(chatId, { kind: null, itemId: 'phone-file', title: 'File' }, { returnTo: board! }))
    expect(harness.container.textContent).toBe('File:1')
    await act(async () => closeChatTab(chatId, file!))
    expect(harness.container.textContent).toBe('Board:1')
    await act(async () => closeChatTab(chatId, board!))
    expect(harness.container.textContent).toBe('')
  })
})

describe('a chat\'s info is one of its tabs (owner 10-26)', () => {
  it('opens beside the chat at the page asked for, and once: opened again it comes forward', async () => {
    const chatId = 'info-tab'
    await act(async () => openInfoTab(chatId, 'members'))
    const first = infoTabOf(chatId)!
    expect(first.shown).toBe(true)
    expect(first.info.page).toBe('members')
    await act(async () => openPanelItem(chatId, folderItem()))
    expect(infoTabOf(chatId)?.shown, 'the folder takes the place beside the chat').toBe(false)
    await act(async () => openInfoTab(chatId))
    expect(infoTabOf(chatId)?.tabId, 'still one info tab').toBe(first.tabId)
    expect(infoTabOf(chatId)?.shown).toBe(true)
    expect(infoTabOf(chatId)?.info.page, 'brought forward as it was').toBe('members')
    await act(async () => closeInfoTab(chatId))
    expect(infoTabOf(chatId)).toBeNull()
  })

  it('on the phone it is the page in front', async () => {
    const chatId = 'info-phone'
    await harness.render(createElement(ChatTabPage, { chatId, panel: () => null, topic: () => null, info: () => createElement('article', null, 'Info') }))
    expect(harness.container.textContent).toBe('')
    await act(async () => openInfoTab(chatId))
    expect(harness.container.textContent).toBe('Info')
    await act(async () => closeInfoTab(chatId))
    expect(harness.container.textContent).toBe('')
  })
})
