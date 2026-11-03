// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { createReactHarness } from '../../../support/testHarness'
import { installShellSlots } from '../../../../apps/desktop/src/lib/shellSlots'
import { folderItem } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-panel-item'
import { chatLayoutOf, chatPaneOf, closeChatTab, closeInfoTab, infoTabOf, openInfoTab, openPanelItem, openTopicTab, showChatOnly, showChatTab } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts'
import { ChatTabHostContext } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-tab-providers'
import { ChatTabPage, ChatTabPortals } from '../../../../apps/desktop/src/components/appSlot/ChatTabHosts'
import { PaneContent } from '../../../../apps/desktop/src/session/renderer/features/tabs/pane-content'
import { PaneContext } from '../../../../apps/desktop/src/session/renderer/features/tabs/pane-context'
import { KEPT_HIDDEN_TABS } from '../../../../apps/desktop/src/session/renderer/features/tabs/retained-tab-content'
import { MessageFilePreviewPanel } from '../../../../apps/desktop/src/components/chat/MessageFilePreviewPanel'

vi.mock('react-i18next', async original => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('@/components/markdown/Markdown', () => ({ Markdown: () => null }))
vi.mock('@/components/chat/DocumentPreviewContent', () => ({ DocumentPreviewContent: () => null }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { vi.stubGlobal('CSS', { escape: (id: string) => id }); installShellSlots(); harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })
const slots = () => [...harness.container.querySelectorAll('[data-chat-tab-slot]')].map((element) => element.getAttribute('data-chat-tab-slot'))
const Panels = observer(function Panels({ chatId }: { chatId: string }) {
  return <>{chatLayoutOf(chatId).groups.map(group => <PaneContext.Provider key={group.paneId} value={{ paneId: group.paneId, pane: group.pane, isFocusedPane: true }}><PaneContent hideTabBar /></PaneContext.Provider>)}</>
})
const portal = (chatId: string) => <><Panels chatId={chatId} /><ChatTabPortals chatId={chatId} panel={tab => <textarea data-draft={tab.tabId} defaultValue={tab.item.title} />} topic={() => <textarea data-topic-draft defaultValue="topic" />} info={() => <textarea data-info-draft defaultValue="info" />} /></>

describe('chat slots follow actual panes and navigation contexts', () => {
  it.each(['private-card', 'group-folder'])('carries the owning pane through the real %s portal into the shared file toolbar', async origin => {
    const id = `native-toolbar-${origin}`
    const layout = chatLayoutOf(id)
    layout.focusedPane.setDimensions(390, 620)
    const from = origin === 'group-folder' ? openPanelItem(id, folderItem(), { intent: 'newTab' }) : undefined
    const tabId = openPanelItem(id, { kind: null, title: 'notes.txt', itemId: `notes-${origin}` }, from ? { from } : undefined)!
    await harness.render(<><Panels chatId={id} /><ChatTabPortals chatId={id} panel={tab => <MessageFilePreviewPanel fill tabbed file={{ fileName: tab.item.title, sizeBytes: 12, mimeType: 'text/plain' }} kind="text" content="notes" loading={false} onClose={() => closeChatTab(id, tab.tabId)} />} topic={() => null} info={() => null} /></>)
    const toolbar = harness.container.querySelector('[data-file-toolbar]')
    expect(toolbar).not.toBeNull()
    expect(toolbar!.querySelector('[aria-label="tabs.read"]')).not.toBeNull()
    expect(toolbar!.querySelector<HTMLButtonElement>('[aria-label="tabs.edit"]')!.disabled).toBe(true)
    const back = toolbar!.querySelector<HTMLButtonElement>(`[aria-label="${from ? 'tabs.back' : 'tabs.backToConversation'}"]`)!
    expect(back).not.toBeNull()
    expect(back.disabled).toBe(false)
    await act(async () => back.click())
    expect(chatPaneOf(id, tabId)!.activeEntry?.kind).toBe(from ? 'chat-panel' : 'chat')
  })

  it('adds a slot after mount, keeps independent tabs, and releases only the closed slot', async () => {
    const id = 'slots-v3'; await harness.render(<Panels chatId={id} />); expect(slots()).toEqual([])
    const folder = await act(async () => openPanelItem(id, folderItem()))!
    const board = await act(async () => openPanelItem(id, { kind: 'kanban.board', title: 'Board' }, { from: folder!, intent: 'newTab' }))!
    expect(slots().sort()).toEqual([folder, board].sort())
    await act(async () => showChatOnly(id)); expect(slots().sort()).toEqual([folder, board].sort())
    await act(async () => closeChatTab(id, board!)); expect(slots()).toEqual([folder])
    await act(async () => closeChatTab(id, folder!)); expect(slots()).toEqual([])
  })
  it('retains drafts when switching contexts and moving a tab into a real pane', async () => {
    const id = 'drafts-v3'; const folder = openPanelItem(id, folderItem())!
    await harness.render(portal(id))
    const draft = harness.container.querySelector<HTMLTextAreaElement>(`[data-draft="${folder}"]`)!
    draft.value = 'unfinished'; draft.scrollTop = 42
    const board = await act(async () => openPanelItem(id, { kind: 'kanban.board', title: 'Board' }, { from: folder, intent: 'newTab' }))!
    expect(harness.container.querySelector(`[data-draft="${folder}"]`)).toBe(draft)
    await act(async () => showChatTab(id, folder)); expect([draft.value, draft.scrollTop]).toEqual(['unfinished', 42])
    const layout = chatLayoutOf(id); const source = layout.groups.find(g => g.pane.entries.has(board!))!
    const destination = layout.groups.find(g => g !== source)!
    await act(async () => layout.moveTab(board!, source.paneId, destination.paneId))
    expect(slots().filter(tab => tab === board)).toHaveLength(1)
    expect(chatPaneOf(id, board!)?.entries.has(board!)).toBe(true)
  })
  it('bounds hidden slots while leaving each explicitly open context in the model', async () => {
    const id = 'bound-v3'; const folder = openPanelItem(id, folderItem())!
    await harness.render(portal(id))
    for (let i = 0; i < KEPT_HIDDEN_TABS + 2; i++) await act(async () => openPanelItem(id, { kind: 'workspace.main', itemId: `f-${i}`, title: `f-${i}` }, { from: folder, intent: 'newTab' }))
    expect(slots()).toHaveLength(KEPT_HIDDEN_TABS + 1)
    expect(harness.container.querySelector(`[data-draft="${folder}"]`)).toBeNull()
    expect(chatPaneOf(id, folder)?.entries.has(folder)).toBe(true)
  })
})

describe('the phone draws the selected context', () => {
  it('changes the page in place and returns through its history', async () => {
    const id = 'phone-history-v3'; let mounted = 0
    function Panel({ title }: { title: string }) { const [instance] = useState(() => ++mounted); return <article>{title}:{instance}</article> }
    await harness.render(<ChatTabPage chatId={id} panel={tab => <Panel title={tab.item.title} />} topic={() => <article>Topic</article>} info={() => <article>Info</article>} />)
    const board = await act(async () => openPanelItem(id, { kind: 'kanban.board', title: 'Board' }))!
    expect(harness.container.textContent).toBe('Board:1')
    const file = await act(async () => openPanelItem(id, { kind: null, itemId: 'file', title: 'File' }, { from: board! }))!
    expect(file).toBe(board); expect(harness.container.textContent).toBe('File:1')
    await act(async () => chatPaneOf(id, board!)!.go(board!, -1)); expect(harness.container.textContent).toBe('Board:1')
    await act(async () => closeChatTab(id, board!)); expect(harness.container.textContent).toBe('')
  })
  it('shows a topic or info page and closes back to the conversation', async () => {
    const id = 'phone-info-v3'
    await harness.render(<ChatTabPage chatId={id} panel={() => null} topic={() => <article>Topic</article>} info={() => <article>Info</article>} />)
    await act(async () => openTopicTab(id, { topicChatId: 'topic', name: 'Topic' })); expect(harness.container.textContent).toBe('Topic')
    await act(async () => openInfoTab(id, 'members')); expect(harness.container.textContent).toBe('Info')
    await act(async () => closeInfoTab(id)); expect(harness.container.textContent).toBe('')
  })
})

it('keeps the conversation mounted when its companion is selected', async () => {
  const id = 'hidden-chat-v3'; openInfoTab(id, 'members')
  const host = { chip: () => null, body: <div data-chat-body />, ownBlock() {} }
  await harness.render(<ChatTabHostContext.Provider value={host}><Panels chatId={id} /><ChatTabPortals chatId={id} panel={() => null} topic={() => null} info={() => <article>Info</article>} /></ChatTabHostContext.Provider>)
  expect(harness.container.querySelector('[data-chat-body]')).not.toBeNull()
  expect(slots()).toEqual([infoTabOf(id)!.tabId])
})
