// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { GroupAppSlot, WORKSPACE_APP_KIND } from '../../../../apps/desktop/src/components/appSlot/GroupAppSlot'
import { groupSlotMemory } from '../../../../apps/desktop/src/components/appSlot/groupSlotMemory'
import { APP_OPEN_WITH_EVENT } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { AuthContext } from '../../../../apps/desktop/src/store/auth'

/**
 * 最近打开 (gugu-supabase 20261017024605): a file the person opens in a group's panel is kept for them once
 * (`workspace_note_open`) — the panel showing it again when the person comes back to the group is not another open. And
 * an App's `files.openWith` for another chat's file is not this panel's to open: it goes to the chat shell
 * (`APP_OPEN_WITH_EVENT`, MainLayout), which brings that chat up. The harness is groupFileLastAsk7257's.
 */
const rpc = vi.hoisted(() => vi.fn(async () => ({ data: null, error: null })))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { rpc } }))
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

let harness: ReturnType<typeof createReactHarness>
const originalCheckVisibility = HTMLElement.prototype.checkVisibility
beforeEach(() => {
  harness = createReactHarness()
  HTMLElement.prototype.checkVisibility = () => false
  rpc.mockClear()
})
afterEach(() => {
  harness.cleanup()
  HTMLElement.prototype.checkVisibility = originalCheckVisibility
})

const detailOf = (chatId: string, itemId: string) => ({
  chatId, itemId, name: `${itemId}.pptx`, typedName: `${itemId}.pptx`,
  choice: { kind: 'one', candidate: { extensionId: 'office', tabKind: 'office.main', tabTitle: 'Office', app: { name: '咕咕办公' }, onlyTab: true, claim: '.pptx', suffix: '.pptx' } },
})
let request = 7400_000
const slot = (props: Partial<ComponentProps<typeof GroupAppSlot>>) =>
  createElement(AuthContext.Provider, { value: { user: { id: 'user-1' } } as never },
    createElement(GroupAppSlot, { chatId: 'g1', kind: WORKSPACE_APP_KIND, title: 'Workspace', onClose: vi.fn(), ...props }))
const asked = (chatId: string, opener: ReturnType<typeof detailOf>) => ({ chatId, itemId: opener.itemId, request: ++request, opener: opener as never })

describe('a file opened in a group\'s panel is kept for 最近打开, once', () => {
  it('opened: one workspace_note_open with its id; shown again when the person comes back: no other', async () => {
    await harness.render(slot({ chatId: 'g-note', fileToOpen: asked('g-note', detailOf('g-note', 'F1')) }))
    expect(groupSlotMemory.opened('g-note')?.itemId).toBe('F1')
    expect(rpc.mock.calls).toEqual([['workspace_note_open', { p_item_id: 'F1' }]])
    // The person goes to another chat and comes back: the panel shows F1 again from what it remembered.
    harness.cleanup()
    harness = createReactHarness()
    await harness.render(slot({ chatId: 'g-note' }))
    expect(groupSlotMemory.opened('g-note')?.itemId).toBe('F1')
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('an App\'s own page in the panel (no file) is not a file opened: nothing kept', async () => {
    groupSlotMemory.setOpened('g-page', null)
    await harness.render(slot({ chatId: 'g-page' }))
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('files.openWith for another chat\'s file goes to the chat shell', () => {
  it('this panel opens nothing and keeps nothing; the shell is told, with the host\'s answer', async () => {
    const heard: unknown[] = []
    const listen = (event: Event) => heard.push((event as CustomEvent).detail)
    window.addEventListener(APP_OPEN_WITH_EVENT, listen)
    try {
      const other = detailOf('g-other', 'F2')
      await act(async () => {
        await harness.render(slot({ chatId: 'g-here', fileToOpen: { ...asked('g-here', other), itemId: 'F2' } }))
      })
      expect(heard).toEqual([other])
      expect(groupSlotMemory.opened('g-here')?.itemId ?? null).toBe(null)
      expect(rpc).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(APP_OPEN_WITH_EVENT, listen)
    }
  })
})
