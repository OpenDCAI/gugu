// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, waitForCondition } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/lib/firstRun', () => ({ writeFirstRunTerminalSeen: vi.fn(async () => undefined) }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ update: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/settings/use-terminal-enabled', () => ({ useTerminalEnabled: () => false }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: {} }))
await import('../../../../apps/desktop/src/i18n/registerMainCatalog')
const { i18n } = await import('../../../../apps/desktop/src/i18n/runtime')
const { FirstRunTerminal } = await import('../../../../apps/desktop/src/components/firstRun/FirstRunTerminal')
const { Tooltip } = await import('../../../../apps/desktop/src/components/ui/Tooltip')

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => vi.unstubAllGlobals())

describe('first-run terminal labels and playback hint', () => {
  it.each([
    ['zh-CN', '终端', '启用终端', '暂停', '播放'],
    ['en-US', 'Terminal', 'Enable terminal', 'Pause', 'Play'],
  ])('%s shows the terminal labels and updates its visible hint with playback', async (locale, title, enable, pause, play) => {
    await i18n.changeLanguage(locale)
    const h = createReactHarness()
    try {
      await h.render(createNode(Tooltip.Provider, { delay: 0, closeDelay: 0 }, createNode(FirstRunTerminal, { userId: 'owner-1', onBack: vi.fn(), onDone: vi.fn() })))
      expect(h.container.querySelector('h1')?.textContent).toBe(title)
      expect(h.container.querySelector(`[aria-label="${enable}"]`)).not.toBeNull()
      expect(h.container.textContent).toContain(enable)
      const control = () => h.container.querySelector<HTMLButtonElement>('[data-testid="first-run-terminal-film-toggle"]')!
      expect(control().getAttribute('aria-label')).toBe(pause)
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
        control().focus()
      })
      await waitForCondition(() => !!document.querySelector('[data-slot="tooltip-popup"]'), 'playback hint shown on focus')
      expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(pause)
      await act(async () => h.container.querySelector('video')!.dispatchEvent(new Event('pause')))
      expect(control().getAttribute('aria-label')).toBe(play)
      expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(play)
    } finally { h.cleanup() }
  })
})
