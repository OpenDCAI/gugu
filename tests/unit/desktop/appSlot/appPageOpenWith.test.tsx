// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { APP_OPEN_WITH_EVENT } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

/**
 * The phone's App frame outside a chat — an App's own page (the 「App」 page's 「打开」) and a session's tab: a chat file
 * its `files.openWith` names is the chat shell's to open (`APP_OPEN_WITH_EVENT`, MainLayout brings the chat up) — never
 * nothing (before, a session page's openWith was dropped).
 */
const host = vi.hoisted(() => ({ hooks: null as null | { openWith(detail: unknown): void }, filesChanged: [] as unknown[] }))
vi.mock('../../../../apps/desktop/src/components/appSlot/phoneAppHost', () => ({
  hostAppFrame: (_frame: unknown, _binding: unknown, hooks: { openWith(detail: unknown): void }) => {
    host.hooks = hooks
    return { update: () => undefined, dispose: () => undefined, programNotified: () => undefined, filesChanged: async (changes: unknown) => { host.filesChanged.push(changes) } }
  },
}))
// The account revision bus, as the chat store hands it out: what each frame subscribed to.
const revisions = vi.hoisted(() => new Map<string, (operations: { payload: unknown }[]) => void>())
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  useChatStore: () => ({ subscribeAccountRevision: (event: string, listener: (operations: { payload: unknown }[]) => void) => { revisions.set(event, listener); return () => revisions.delete(event) } }),
}))
vi.mock('../../../../apps/desktop/src/components/appSlot/phoneApps', () => ({ phoneApps: { pageUrl: () => 'https://office.apps.gugu.invalid/home.html' } }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: {
    isLoaded: true,
    isEnabled: () => true,
    manifestFor: () => ({ id: 'office', version: '0.2.0', entry: 'index.html', permissions: { capabilities: ['files:read'] }, contributes: { tabs: [{ name: 'home', title: 'Office', entry: 'home.html' }] } }),
  },
}))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [] }) }))
vi.mock('../../../../apps/desktop/src/store/theme', () => ({ useTheme: () => ({ theme: 'light' }) }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ onMachineChannel: () => () => undefined }))

const { SessionAppFrame } = await import('../../../../apps/desktop/src/components/appSlot/SessionAppFrame')

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  host.hooks = null
  host.filesChanged.length = 0
  revisions.clear()
})
afterEach(() => harness.cleanup())

describe('an App\'s page outside a chat: files.openWith goes to the chat shell', () => {
  it.each([
    ['its own page (no session)', {}],
    ['a session\'s tab', { session: { id: 's1' }, device: { device_id: 'd1', label: 'Mac', is_online: true } }],
  ])('%s: the shell is told, with the host\'s answer', async (_name, place) => {
    await harness.render(createElement(SessionAppFrame, { kind: 'office.home', ...(place as object) }))
    expect(host.hooks, 'the frame was hosted').not.toBeNull()
    const heard: unknown[] = []
    const listen = (event: Event) => heard.push((event as CustomEvent).detail)
    window.addEventListener(APP_OPEN_WITH_EVENT, listen)
    try {
      const detail = { chatId: 'g1', itemId: 'F1', name: 'F1.md', typedName: 'F1.md', choice: { kind: 'none' } }
      host.hooks!.openWith(detail)
      expect(heard).toEqual([detail])
    } finally {
      window.removeEventListener(APP_OPEN_WITH_EVENT, listen)
    }
  })
})

describe('an App\'s page outside a chat hears the chats\' files change, as a chat\'s panel does', () => {
  it('a session\'s tab: files.onChanged is told of the changed files (before, its frame never subscribed)', async () => {
    await harness.render(createElement(SessionAppFrame, { kind: 'office.home', session: { id: 's1' }, device: { device_id: 'd1', label: 'Mac', is_online: true } } as never))
    expect([...revisions.keys()], 'no chat, no members to hear about').toEqual(['workspace_changed'])
    revisions.get('workspace_changed')!([{ payload: { chat_id: 'g1', entity_id: 'F1' } }])
    expect(host.filesChanged).toEqual([[{ chatId: 'g1', itemIds: ['F1'] }]])
  })
})
