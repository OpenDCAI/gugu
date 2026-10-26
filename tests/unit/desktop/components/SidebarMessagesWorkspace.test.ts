// @vitest-environment jsdom
import { runInAction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../../../apps/desktop/src/components/Sidebar'
import { appState } from '../../../../apps/desktop/src/session/renderer/lib/stores/app-state'
import { screenLayout, type ScreenBlockContent } from '../../../../apps/desktop/src/session/renderer/app/screen-layout'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

afterEach(() => runInAction(() => {
  screenLayout.layout = null
  screenLayout.blocks.clear()
  screenLayout.parked.clear()
  screenLayout.focusedBlockId = null
  screenLayout.lastSessionBlockId = null
  appState.navigation.viewParamsStore = {}
}))

async function clickMessages() {
  const harness = createReactHarness()
  try {
    await renderWithAppProviders(harness, createNode(Sidebar, { activeTab: 'tasks', onTabChange: vi.fn() }), {
      auth: { id: 'u1', email: 'u@example.test', nickname: 'U' },
    })
    await clickElement(harness.container.querySelector('[data-testid="sidebar-messages-nav"]')!)
  } finally {
    harness.cleanup()
  }
}

describe('Messages returns to the shared screen', () => {
  const contents: Exclude<ScreenBlockContent, { kind: 'chat-app' }>[] = [
    { kind: 'chat', chatId: 'chat-1' },
    { kind: 'project', projectId: 'project-1' },
    { kind: 'session', projectId: 'project-1', sessionId: 'session-1' },
    { kind: 'app', tabKind: 'notes.main' },
  ]
  for (const content of contents) {
    for (const away of ['assistant', 'library', 'app'] as const) {
      it(`returns from ${away} to the focused ${content.kind} without replacing its group`, async () => {
        appState.navigation.navigate('session', { projectId: 'old-project', sessionId: 'old-session' })
        screenLayout.show({ kind: 'chat', chatId: 'beside' })
        screenLayout.showBeside(content)
        const saved = screenLayout.snapshot
        appState.navigation.navigate(away)

        await clickMessages()

        expect(appState.navigation.currentViewId).toBe(content.kind === 'app' ? 'screen' : content.kind)
        expect(screenLayout.snapshot).toEqual(saved)
        if (content.kind !== 'app') expect(appState.navigation.viewParamsStore[content.kind]).toMatchObject(content.kind === 'session'
          ? { projectId: content.projectId, sessionId: content.sessionId }
          : content.kind === 'chat' ? { chatId: content.chatId } : { projectId: content.projectId })
      })
    }
  }

  it('an empty screen opens home instead of reopening stale session parameters', async () => {
    appState.navigation.navigate('session', { projectId: 'old-project', sessionId: 'old-session' })
    appState.navigation.navigate('assistant')
    await clickMessages()
    expect(appState.navigation.currentViewId).toBe('home')
    expect(screenLayout.snapshot).toBeNull()
  })

  it('a screen containing only an App remains a screen', async () => {
    screenLayout.show({ kind: 'app', tabKind: 'notes.main' })
    const saved = screenLayout.snapshot
    appState.navigation.navigate('assistant')
    await clickMessages()
    expect(appState.navigation.currentViewId).toBe('screen')
    expect(screenLayout.snapshot).toEqual(saved)
  })
})
