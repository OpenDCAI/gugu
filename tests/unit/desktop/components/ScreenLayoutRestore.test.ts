// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  localStorage.clear()
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

for (const kind of ['app', 'chat-app', 'session-app', 'project', 'fresh', 'legacy-chat'] as const) {
  it(`cold start restores ${kind} from the workspace before following navigation`, async () => {
    const { appState } = await import('../../../../apps/desktop/src/session/renderer/lib/stores/app-state')
    const { ScreenLayoutStore, screenLayout } = await import('../../../../apps/desktop/src/session/renderer/app/screen-layout')
    const { installedExtensionsStore } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store')
    installedExtensionsStore.applyList({ extensions: [{ id: 'notes', name: 'Notes', version: '1.0.0', apiVersion: 1, entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Notes' }] } }], invalid: [], icons: {}, disabled: [], disclosure: {} } as never)
    for (const view of ['home', 'chat', 'project', 'session', 'screen'] as const) appState.navigation.registerView(view)
    appState.navigation.restoreSnapshot({ currentViewId: kind === 'fresh' ? 'home' : kind === 'session-app' ? 'session' : 'chat', viewParams: { chat: { chatId: 'old-chat' }, session: { projectId: 'shown-project', sessionId: 'shown-session' } } })
    const saved = new ScreenLayoutStore()
    if (kind === 'session-app') saved.show({ kind: 'session', projectId: 'shown-project', sessionId: 'shown-session' })
    if (kind === 'chat-app') saved.show({ kind: 'chat', chatId: 'shown-chat' })
    if (kind === 'app' || kind === 'chat-app' || kind === 'session-app') saved.showBeside({ kind: 'app', tabKind: 'notes.main' })
    if (kind === 'project') saved.show({ kind: 'project', projectId: 'shown-project' })
    if (saved.snapshot) localStorage.setItem('gugu.screen-layout.v1', JSON.stringify(saved.snapshot))

    const { ensureScreenLayoutSync } = await import('../../../../apps/desktop/src/session/renderer/app/screen-layout-actions')
    ensureScreenLayoutSync()

    if (kind === 'legacy-chat') expect(screenLayout.snapshot?.blocks).toEqual(expect.objectContaining({ [screenLayout.focusedBlockId!]: { kind: 'chat', chatId: 'old-chat' } }))
    else expect(screenLayout.snapshot).toEqual(saved.snapshot)
    expect(appState.navigation.currentViewId).toBe(kind === 'app' || kind === 'chat-app' ? 'screen' : kind === 'project' ? 'project' : kind === 'session-app' ? 'session' : kind === 'fresh' ? 'home' : 'chat')
    // A later explicit navigation still opens its target through the same screen owner.
    appState.navigation.navigate('chat', { chatId: 'next-chat' })
    expect(screenLayout.blocks.get(screenLayout.focusedBlockId!)).toEqual({ kind: 'chat', chatId: 'next-chat' })
  })
}
