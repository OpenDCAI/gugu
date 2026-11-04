// @vitest-environment jsdom
import { act } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@/components/appSlot/GroupTabContent', () => ({ GroupTabContent: () => <div>authorized HTML preview</div> }))
vi.mock('@/components/appSlot/useChatOpener', () => ({ useChatOpener: () => ({ overlay: null, openWith: vi.fn() }) }))
vi.mock('@/session/renderer/features/chats/chat-tabs/chat-layouts', () => ({ panelTabsOf: () => [{ tabId: 'file', item: { kind: null }, shown: true }], panelTabOf: vi.fn(), openPanelItem: vi.fn(), closeChatTab: vi.fn() }))
import { OwnedAgentResourcesHost } from '../../../../apps/desktop/src/components/appSlot/OwnedAgentResourcesHost'
import { clearOwnedAgentResources, hostOwnedAgentResources, ownedAgentResourceSlotKey } from '../../../../apps/desktop/src/lib/ownedAgentResources'
import { chatTabSlotKey, installShellSlots, readShellSlots } from '../../../../apps/desktop/src/lib/shellSlots'
let harness: ReturnType<typeof createReactHarness>
afterEach(() => { harness?.cleanup(); clearOwnedAgentResources('owner'); document.body.innerHTML = ''; for (const key of readShellSlots()?.getSlots().keys() ?? []) readShellSlots()?.setSlot(key, null) })
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
