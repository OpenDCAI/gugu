// @vitest-environment jsdom
import { act, createRef } from 'react'
import { runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'

// 5-minute game ①: an agent makes a group game (template group-json: one tab, on the group's data file) and installs it into the
// group; the group's App list never showed it — the list held only Apps with a page of their own.
const files = vi.hoisted(() => ({ byApp: {} as Record<string, number>, asked: [] as string[] }))
vi.mock('@/components/appSlot/appsHere', () => ({
  appsHere: {
    groupFilesOpenedBy: async ({ chatId, extensionId }: { chatId: string; extensionId: string }) => {
      files.asked.push(`${chatId}/${extensionId}`)
      return { success: true, data: Array.from({ length: files.byApp[extensionId] ?? 0 }, (_, n) => ({ itemId: `${extensionId}-${n}`, name: 'game.ttt.json', displayName: 'game' })) }
    },
  },
}))

const { GroupAppsPicker } = await import('@/components/chat/GroupAppsPicker')
const { installedExtensionsStore } = await import('@/session/renderer/features/extensions/installed-extensions-store')
const { EXTENSION_API_VERSION, parseExtensionManifest } = await import('@/session/shared/extensions/manifest')
const { UI_EVENTS } = await import('@/lib/uiEvents')

const manifest = (id: string, tab: Record<string, unknown>) =>
  parseExtensionManifest({ id, name: id, version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html', contributes: { tabs: [{ name: 'main', title: id, ...tab }] } })

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  files.byApp = { tictactoe: 1 }; files.asked = []
  harness = createReactHarness()
  runInAction(() => {
    installedExtensionsStore.manifests = [
      manifest('board', {}),
      manifest('tictactoe', { opensFiles: { chat: ['.tictactoe.json'] } }),
      manifest('sheet', { opensFiles: { chat: ['.sheet.json'] } }),
    ]
    installedExtensionsStore.disabled = []
    installedExtensionsStore.isLoaded = true
  })
})
afterEach(() => {
  harness.cleanup()
  runInAction(() => { installedExtensionsStore.manifests = []; installedExtensionsStore.disabled = []; installedExtensionsStore.isLoaded = false })
})

const pins = { ids: [], ready: true, saving: false, error: null, set: vi.fn(), retry: vi.fn() } as never
async function picker(chatId = 'g1') {
  await renderWithAppProviders(harness, createNode(GroupAppsPicker, { chatId, pins, mobile: true, anchor: createRef<HTMLButtonElement>(), onClose: vi.fn() }))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return [...document.querySelectorAll<HTMLElement>('[data-app-id]')].map((row) => row.dataset.appId)
}

describe('the group\'s App list holds the group game an agent installed', () => {
  it('lists an App that opens this group\'s file beside the Apps with a page of their own; one with no file here is left out', async () => {
    expect(await picker()).toEqual(['board', 'tictactoe'])
    expect(files.asked.sort()).toEqual(['g1/sheet', 'g1/tictactoe'])
  })

  it('[control] with no file of it in this group the game is not listed (it would open nothing)', async () => {
    files.byApp = {}
    expect(await picker()).toEqual(['board'])
  })

  it('opens it in this group the way its card\'s Open does', async () => {
    await picker()
    const opened = vi.fn()
    window.addEventListener(UI_EVENTS.openApp, opened)
    await clickElement(document.querySelector('[data-app-id="tictactoe"] [data-testid="group-apps-open"]')!)
    window.removeEventListener(UI_EVENTS.openApp, opened)
    expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({ extensionId: 'tictactoe', chatId: 'g1' })
  })

  it('a switched-off game is not listed', async () => {
    runInAction(() => { installedExtensionsStore.disabled = ['tictactoe'] })
    expect(await picker()).toEqual(['board'])
  })
})
