// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules(); localStorage.clear() })

async function rig() {
  const { appState } = await import('../../../../apps/desktop/src/session/renderer/lib/stores/app-state')
  for (const view of ['home', 'chat', 'project', 'session', 'screen'] as const) appState.navigation.registerView(view)
  const { screenLayout } = await import('../../../../apps/desktop/src/session/renderer/app/screen-layout')
  const actions = await import('../../../../apps/desktop/src/session/renderer/app/screen-layout-actions')
  const { provideChatWindowReads } = await import('../../../../apps/desktop/src/lib/chatWindowReads')
  const pending = new Map<string, () => void>()
  const held = new Set<string>()
  const release = vi.fn()
  provideChatWindowReads({
    read: (chatId) => held.has(chatId) ? null : new Promise<void>(resolve => pending.set(chatId, () => { held.add(chatId); resolve() })),
    release,
  })
  const shown = () => screenLayout.focusedBlockId ? screenLayout.blocks.get(screenLayout.focusedBlockId) : undefined
  return { actions, pending, release, shown, settle: async (chatId: string) => { pending.get(chatId)!(); await Promise.resolve(); await Promise.resolve() } }
}

it('shows a conversation only after its window is read, and at once when it is held', async () => {
  const r = await rig()
  r.actions.showOnScreen({ kind: 'chat', chatId: 'a' })
  expect(r.shown()).toBeUndefined()
  await r.settle('a')
  expect(r.shown()).toEqual({ kind: 'chat', chatId: 'a' })
  r.actions.showOnScreen({ kind: 'project', projectId: 'p' })
  r.actions.showOnScreen({ kind: 'chat', chatId: 'a' })
  expect(r.shown()).toEqual({ kind: 'chat', chatId: 'a' })
})

it('applies only the latest request and hands back a superseded read', async () => {
  const r = await rig()
  r.actions.showOnScreen({ kind: 'chat', chatId: 'a' })
  r.actions.showOnScreen({ kind: 'chat', chatId: 'b' })
  await r.settle('a')
  expect(r.shown()).toBeUndefined()
  expect(r.release).toHaveBeenCalledExactlyOnceWith('a')
  await r.settle('b')
  expect(r.shown()).toEqual({ kind: 'chat', chatId: 'b' })
})
