// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { createReactHarness } from '../../../support/testHarness'
import { until } from '../../../support/awaitCondition'
import { useMessageFilePreview } from '../../../../apps/desktop/src/components/chat/useMessageFilePreview'
import { useChatOpener } from '../../../../apps/desktop/src/components/appSlot/useChatOpener'
import { useLinkNavigation } from '../../../../apps/desktop/src/hooks/useLinkNavigation'
import { appsHere } from '../../../../apps/desktop/src/components/appSlot/appsHere'
import { askChat, chatLayoutOf, openTopicTab, panelTabsOf, topicTabOf } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts'

vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron', capabilities: {} } }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({ localFileRevision: async () => ({ chat_id: 'topic-file-entry' }) }))
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({ appsHere: { groupFileOpener: vi.fn() } }))

const group = 'topic-file-entry'
const harness = createReactHarness()
afterEach(() => harness.cleanup())
function Entry({ topic }: { topic: string }) {
  useLinkNavigation({ ownerId: 'owner', chats: [{ id: group, kind: 'group' }] as never, contacts: [],
    openChat() {}, openFile: (chatId, target, source) => askChat(chatId, { itemId: target.itemId, ...source }),
    openApp() {}, openOwnApp() {}, openProject() {}, openAssistant() {},
  })
  useChatOpener(group)
  const preview = useMessageFilePreview({ mobile: false, visible: true, closeRightSurfaces() {}, toast() {} })
  return createElement('button', { onClick: () => preview.open({ kind: 'file', fileName: 'README.md', mimeType: 'text/markdown', sizeBytes: 100, source: { kind: 'item', itemId: 'shared-file' } }, { id: `message-${topic}`, chat_id: topic } as MessageItem) }, 'Open attachment')
}

it('carries the actual attachment click through file resolution into the topic/file pair; the latest source wins', async () => {
  vi.mocked(appsHere!.groupFileOpener).mockImplementation(async () => ({ success: true, data: {
    chatId: group, itemId: 'shared-file', name: 'README.md', typedName: 'README.md',
    choice: { kind: 'one', candidate: { tabKind: 'workspace.file', suffix: '.md' } },
  } }) as never)
  openTopicTab(group, { topicChatId: 'topic-a', name: 'A' })
  await harness.render(createElement(Entry, { topic: 'topic-a' }))
  await act(async () => harness.container.querySelector('button')!.click())
  await until('the actual opener resolved the attachment', () => panelTabsOf(group).length === 1)
  const layout = chatLayoutOf(group)
  const pane = layout.groups[0]!.pane
  const file = panelTabsOf(group)[0]!.tabId
  expect(pane.livePair).toMatchObject({ anchor: topicTabOf(group)!.tabId, side: file })
  expect(panelTabsOf(group)[0]!.item.message?.chat_id).toBe('topic-a')
  act(() => openTopicTab(group, { topicChatId: 'topic-b', name: 'B' }))
  await harness.render(createElement(Entry, { topic: 'topic-b' }))
  await act(async () => harness.container.querySelector('button')!.click())
  await until('the latest message replaced the source', () => panelTabsOf(group)[0]?.item.message?.chat_id === 'topic-b')
  expect(panelTabsOf(group)).toHaveLength(1)
  expect(panelTabsOf(group)[0]!.tabId).toBe(file)
  expect(pane.livePair).toMatchObject({ anchor: topicTabOf(group)!.tabId, side: file })
  expect(layout.groups).toHaveLength(1)
})
