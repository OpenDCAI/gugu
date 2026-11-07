// @vitest-environment jsdom
import { act } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { afterEach, expect, it, vi } from 'vitest'
const view = vi.hoisted(() => ({ layout: null as unknown, preview: false }))
vi.mock('@/session/renderer/features/sessions/stores/session-selectors', () => ({ getSessionView: () => view.layout ? { paneLayout: view.layout } : undefined, getSessionPageStore: () => ({ viewModel: { paneLayout: view.layout } }), asProvisioned: (value: unknown) => value }))
vi.mock('@/components/appSlot/GroupTabContent', async () => {
  const { MessageFilePreviewPanel } = await import('@/components/chat/MessageFilePreviewPanel')
  return { GroupTabContent: () => view.preview ? <MessageFilePreviewPanel fill tabbed file={{ fileName: 'notes.txt', sizeBytes: 12, mimeType: 'text/plain' }} kind="text" content="notes" loading={false} onClose={() => {}} /> : <div>authorized HTML preview</div> }
})
vi.mock('react-i18next', async original => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('@/components/markdown/Markdown', () => ({ Markdown: () => null }))
vi.mock('@/components/chat/DocumentPreviewContent', () => ({ DocumentPreviewContent: () => null }))
vi.mock('@/session/renderer/features/sessions/session-pane-ready', () => ({ prepareSessionPane: async () => {} }))
vi.mock('@/components/appSlot/useChatOpener', () => ({ useChatOpener: () => ({ overlay: null, openWith: vi.fn() }) }))
vi.mock('@/session/renderer/features/chats/chat-tabs/chat-layouts', () => ({ panelTabsOf: () => [{ tabId: 'file', item: { kind: null }, shown: true }], panelTabOf: () => ({ tabId: 'file', item: { kind: null, itemId: 'notes', title: 'notes.txt' }, shown: true }), openPanelItem: vi.fn(), closeChatTab: vi.fn() }))
import { PaneLayoutStore } from '@renderer/features/tabs/pane-layout-store'
import { createTabProvider, createTabRegistry } from '@renderer/features/tabs/core/tab-provider-registry'
import { openChatResource } from '@/session/renderer/features/sessions/open-chat-resource'
import { OwnedAgentResourcesHost } from '../../../../apps/desktop/src/components/appSlot/OwnedAgentResourcesHost'
import { clearOwnedAgentResources, hostOwnedAgentResources, ownedAgentResourceSlotKey } from '../../../../apps/desktop/src/lib/ownedAgentResources'
import { chatTabSlotKey, installShellSlots, readShellSlots } from '../../../../apps/desktop/src/lib/shellSlots'
let harness: ReturnType<typeof createReactHarness>
afterEach(() => { harness?.cleanup(); view.layout = null; view.preview = false; clearOwnedAgentResources('owner'); document.body.innerHTML = ''; for (const key of readShellSlots()?.getSlots().keys() ?? []) readShellSlots()?.setSlot(key, null) })
it('keeps the native preview when a restored legacy block creates and removes a panel for the same file', async () => {
  harness = createReactHarness()
  installShellSlots()
  const native = document.createElement('div'), legacy = document.createElement('div')
  document.body.append(native, legacy)
  readShellSlots()!.setSlot(ownedAgentResourceSlotKey('dm', 'file'), native)
  hostOwnedAgentResources('owner', 'dm', { projectId: 'project', sessionId: 'session' })
  await harness.render(<OwnedAgentResourcesHost ownerId="owner" />)
  expect(native.textContent).toBe('authorized HTML preview')
  act(() => { readShellSlots()!.setSlot(chatTabSlotKey('dm', 'file'), legacy) })
  expect(legacy.textContent).toBe('')
  act(() => { readShellSlots()!.setSlot(chatTabSlotKey('dm', 'file'), null) })
  expect(native.textContent).toBe('authorized HTML preview')
  expect(document.body.textContent).toContain('authorized HTML preview')
})

it('carries the actual openChatResource task pane through its native portal without inventing a conversation opener', async () => {
  const provider = (kind: string, conversation = false) => createTabProvider({ kind, conversation, resourceKey: (s: { id?: string; sourceTabId?: string }) => s.id ?? s.sourceTabId ?? '', initialize: () => ({ dispose() {} }), dispose() {}, TabBarItem: () => null, TabBarItemDragPreview: () => null, TabContent: () => null })
  const layout = new PaneLayoutStore(createTabRegistry([provider('session', true), provider('chat-resource')]), { viewId: 'owned-native-toolbar' })
  layout.focusedPane.setDimensions(390, 620)
  const conversation = layout.open('session', { id: 'task' }, { from: null, intent: 'newTab' })!
  view.layout = layout
  await openChatResource({ projectId: 'project', sessionId: 'session', chatId: 'dm', sourceTabId: 'file' })
  const resource = layout.focusedPane.resolvedActiveTabId!
  view.preview = true
  harness = createReactHarness()
  installShellSlots()
  const native = document.createElement('div')
  document.body.appendChild(native)
  readShellSlots()!.setSlot(ownedAgentResourceSlotKey('dm', 'file'), native)
  hostOwnedAgentResources('owner', 'dm', { projectId: 'project', sessionId: 'session' })
  await harness.render(<OwnedAgentResourcesHost ownerId="owner" />)
  try {
    const toolbar = native.querySelector('[data-file-toolbar]')
    expect(toolbar).not.toBeNull()
    expect(toolbar!.querySelector('[aria-label="tabs.back"]')).toBeNull()
    expect(toolbar!.querySelector('[aria-label="tabs.backToConversation"]')).toBeNull()
    expect(layout.focusedPane.resolvedActiveTabId).toBe(resource)
    // Beside the task's conversation: the pair in its one strip (kept when narrow, owner 11-05).
    expect(layout.stripTabIds).toEqual([conversation, resource])
  } finally { layout.dispose() }
})
