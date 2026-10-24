// @vitest-environment jsdom
import { act, createRef } from 'react'
import { runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'

const io = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  failWrite: false,
  readWait: null as Promise<void> | null,
  writeWait: null as Promise<void> | null,
  writing: false,
  listeners: [] as { userId: string; event: string; receive: (payload: unknown) => void; options?: { onSubscribed?: () => void } }[],
  stop: vi.fn(),
}))
vi.mock('@/lib/supabase', async (original) => ({ ...await original<typeof import('@/lib/supabase')>(), identityDb: { from: () => ({
  select: () => ({ eq: (_: string, userId: string) => ({ eq: (_: string, scope: string) => ({ maybeSingle: async () => {
    const data = io.rows.get(`${userId}/${scope}`) ?? null
    const wait = io.readWait; io.readWait = null
    if (wait) await wait
    return { data, error: null }
  } }) }) }),
  upsert: (row: Record<string, unknown>) => ({ select: () => ({ single: async () => {
    if (io.failWrite) return { data: null, error: { message: 'write refused' } }
    io.writing = true
    if (io.writeWait) await io.writeWait
    io.rows.set(`${row.user_id}/${row.scope}`, structuredClone(row))
    return { data: row, error: null }
  } }) }),
}) } }))
vi.mock('@/lib/realtimeChannel', () => ({
  subscribePrivateUserEventBus: (userId: string, event: string, receive: (payload: unknown) => void, options?: { onSubscribed?: () => void }) => {
    io.listeners.push({ userId, event, receive, options })
    return { userId, eventName: event, listenerId: io.listeners.length }
  },
  unsubscribePrivateUserEventBus: io.stop,
}))
vi.mock('@/platform', async (original) => {
  const actual = await original<typeof import('@/platform')>()
  return { ...actual, platform: { ...actual.platform, subscribeAppForeground: () => () => {} } }
})

const { readChatAppPins, setChatAppPin, watchChatAppPins } = await import('@/lib/chatAppPins')
const { queryClient } = await import('@/session/renderer/lib/query-client')
const { ChatHeaderActions } = await import('@/components/chat/ChatHeaderActions')
const { installedExtensionsStore } = await import('@/session/renderer/features/extensions/installed-extensions-store')
const { EXTENSION_API_VERSION, parseExtensionManifest } = await import('@/session/shared/extensions/manifest')
const { UI_EVENTS } = await import('@/lib/uiEvents')

let harness: ReturnType<typeof createReactHarness>
function row(userId: string, chatId: string, ids: string[]) {
  io.rows.set(`${userId}/chat:${chatId}`, { scope: `chat:${chatId}`, config: { pinnedAppIds: ids }, updated_at: '2026-10-24T00:00:00Z' })
}
beforeEach(() => {
  io.rows.clear(); io.listeners.length = 0; io.failWrite = false; io.readWait = null; io.writeWait = null; io.writing = false; io.stop.mockClear()
  queryClient.clear()
  harness = createReactHarness()
  runInAction(() => {
    installedExtensionsStore.manifests = ['board', 'calendar'].map((id) => parseExtensionManifest({ id, name: id, version: '1.0.0', apiVersion: EXTENSION_API_VERSION, entry: 'index.html', contributes: { tabs: [{ name: 'main', title: id }] } }))
    installedExtensionsStore.disabled = []
    installedExtensionsStore.isLoaded = true
  })
})
afterEach(() => {
  harness.cleanup(); queryClient.clear()
  runInAction(() => { installedExtensionsStore.manifests = []; installedExtensionsStore.disabled = []; installedExtensionsStore.isLoaded = false })
})

async function header(chatId = 'g1', userId = 'user-1', mobile = true) {
  await renderWithAppProviders(harness, createNode(ChatHeaderActions, {
    isGroupChat: true, isRoomChat: true, mobile,
    searchMode: false, workspacePanelOpen: false, memberListOpen: false, historyPanelOpen: false, showHeaderMenu: true,
    moreButtonRef: createRef<HTMLButtonElement>(), onEnterSearchMode: vi.fn(), onOpenWorkspacePanel: vi.fn(), onCloseWorkspacePanel: vi.fn(),
    onOpenSettingsDrawer: vi.fn(), onOpenMemberList: vi.fn(), onCloseRightSurfaces: vi.fn(), onOpenHistoryPanel: vi.fn(), onCloseHistoryPanel: vi.fn(),
    onToggleHeaderMenu: vi.fn(), onCloseHeaderMenu: vi.fn(), onOpenAnnouncement: vi.fn(),
  }), { auth: { id: userId }, chat: { activeChatId: chatId, chats: [{ id: chatId, kind: 'group' }] as never } })
}
async function picker() {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === '群 Apps')!
  await clickElement(item)
  await vi.waitFor(() => expect(document.querySelector('[data-testid="group-apps-picker"]')).not.toBeNull())
}

describe('personal group App shortcuts', () => {
  it('persists each user and group separately and retains unrelated preferences', async () => {
    io.rows.set('u1/chat:g1', { scope: 'chat:g1', config: { other: true }, updated_at: 'now' })
    expect(await readChatAppPins('u1', 'g1')).toEqual([])
    await setChatAppPin('u1', 'g1', 'board', true)
    await setChatAppPin('u1', 'g1', 'calendar', true)
    await setChatAppPin('u1', 'g1', 'board', true)
    expect(await readChatAppPins('u1', 'g1')).toEqual(['board', 'calendar'])
    expect(io.rows.get('u1/chat:g1')?.config).toEqual({ other: true, pinnedAppIds: ['board', 'calendar'] })
    expect(await readChatAppPins('u2', 'g1')).toEqual([])
    expect(await readChatAppPins('u1', 'g2')).toEqual([])
    await setChatAppPin('u1', 'g1', 'board', false)
    expect(await readChatAppPins('u1', 'g1')).toEqual(['calendar'])
  })

  it('reports corrupt preferences and rejected writes instead of treating them as saved', async () => {
    io.rows.set('u/chat:g', { scope: 'chat:g', config: { pinnedAppIds: 'board' }, updated_at: 'now' })
    await expect(readChatAppPins('u', 'g')).rejects.toThrow('Invalid pinned')
    row('u', 'g', ['board']); io.failWrite = true
    await expect(setChatAppPin('u', 'g', 'calendar', true)).rejects.toThrow('write refused')
    expect(await readChatAppPins('u', 'g')).toEqual(['board'])
  })

  it('uses the existing account event with exact user/scope filtering and rereads after reconnect', () => {
    const refresh = vi.fn()
    const stop = watchChatAppPins('u', 'g', refresh)
    const listener = io.listeners[0]!
    expect(listener.event).toBe('setting_changed')
    listener.receive({ setting: { user_id: 'other', scope: 'chat:g' } })
    listener.receive({ setting: { user_id: 'u', scope: 'chat:other' } })
    expect(refresh).not.toHaveBeenCalled()
    listener.receive({ setting: { user_id: 'u', scope: 'chat:g' } })
    expect(refresh).toHaveBeenCalledTimes(1)
    listener.options?.onSubscribed?.()
    expect(refresh).toHaveBeenCalledTimes(2)
    stop(); expect(io.stop).toHaveBeenCalledTimes(1)
  })

  it('pins from the phone App list, keeps the shortcut after remount, and unpins without opening it', async () => {
    const asked = vi.fn()
    window.addEventListener(UI_EVENTS.openApp, asked)
    try {
      await header(); await picker()
      const pin = () => document.querySelector<HTMLButtonElement>('button[aria-label="将board固定到本群头栏"]')!
      await vi.waitFor(() => expect(pin().disabled).toBe(false))
      await clickElement(pin())
      await vi.waitFor(() => expect(io.rows.get('user-1/chat:g1')?.config).toEqual({ pinnedAppIds: ['board'] }))
      expect(asked).not.toHaveBeenCalled()
      harness.cleanup(); queryClient.clear(); harness = createReactHarness()
      await header()
      await vi.waitFor(() => expect(document.querySelector('[data-testid="chat-header-menu-app"] .gg-menu-item-label')?.textContent).toBe('board'))
      await clickElement(document.querySelector<HTMLElement>('[data-testid="chat-header-menu-app"]')!)
      expect((asked.mock.calls[0]![0] as CustomEvent).detail).toEqual({ extensionId: 'board', chatId: 'g1' })
      asked.mockClear()
      await picker()
      const unpin = () => document.querySelector<HTMLButtonElement>('button[aria-label="从本群头栏移除board"]')!
      await vi.waitFor(() => expect(unpin().disabled).toBe(false))
      await clickElement(unpin())
      await vi.waitFor(() => expect(io.rows.get('user-1/chat:g1')?.config).toEqual({ pinnedAppIds: [] }))
      expect(asked).not.toHaveBeenCalled()
    } finally { window.removeEventListener(UI_EVENTS.openApp, asked) }
  })

  it('rereads another device’s update and leaves unavailable App ids saved', async () => {
    await header()
    row('user-1', 'g1', ['board', 'uninstalled'])
    io.listeners.at(-1)!.receive({ setting: { user_id: 'user-1', scope: 'chat:g1' } })
    await vi.waitFor(() => expect(document.querySelector('[data-testid="chat-header-menu-app"] .gg-menu-item-label')?.textContent).toBe('board'))
    expect(await readChatAppPins('user-1', 'g1')).toEqual(['board', 'uninstalled'])
    await header('g2')
    await vi.waitFor(() => expect(document.querySelector('[data-testid="chat-header-menu-app"]')).toBeNull())
    await header('g1', 'user-2')
    await vi.waitFor(() => expect(document.querySelector('[data-testid="chat-header-menu-app"]')).toBeNull())
  })

  it('does not let an initial read overwrite an update received while it is in flight', async () => {
    let release!: () => void
    io.readWait = new Promise<void>((resolve) => { release = resolve })
    try {
      await header()
      row('user-1', 'g1', ['calendar'])
      io.listeners.at(-1)!.receive({ setting: { user_id: 'user-1', scope: 'chat:g1' } })
      await vi.waitFor(() => expect(document.querySelector('[data-testid="chat-header-menu-app"] .gg-menu-item-label')?.textContent).toBe('calendar'))
      release()
      await header()
      expect(document.querySelector('[data-testid="chat-header-menu-app"] .gg-menu-item-label')?.textContent).toBe('calendar')
    } finally { release() }
  })

  it('finishes a pending pin in its original group after the person switches groups', async () => {
    row('user-1', 'g2', ['calendar'])
    let release!: () => void
    io.writeWait = new Promise<void>((resolve) => { release = resolve })
    try {
      await header(); await picker()
      const pin = () => document.querySelector<HTMLButtonElement>('button[aria-label="将board固定到本群头栏"]')!
      await vi.waitFor(() => expect(pin().disabled).toBe(false))
      await clickElement(pin())
      await vi.waitFor(() => expect(io.writing).toBe(true))
      await header('g2')
      await vi.waitFor(() => expect(queryClient.getQueryData(['chat-app-pins', 'user-1', 'g2'])).toEqual(['calendar']))
      await act(async () => { release(); await io.writeWait })
      await vi.waitFor(() => expect(queryClient.getQueryData(['chat-app-pins', 'user-1', 'g1'])).toEqual(['board']))
      expect(queryClient.getQueryData(['chat-app-pins', 'user-1', 'g2'])).toEqual(['calendar'])
    } finally { release() }
  })
})
