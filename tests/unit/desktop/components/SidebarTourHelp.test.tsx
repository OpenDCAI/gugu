// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', async (original) => {
  const actual = await original<typeof import('../../../../apps/desktop/src/platform')>()
  return { ...actual, platform: { ...actual.platform, kind: 'electron' } }
})
const progress = vi.hoisted(() => ({ value: null as null | { step: 'chats'; status: 'skipped' } }))
vi.mock('../../../../apps/desktop/src/lib/productTour', async (original) => ({
  ...await original<Record<string, unknown>>(), useProductTourState: () => ({ data: progress.value }),
}))
const { Sidebar } = await import('../../../../apps/desktop/src/components/Sidebar')
const { i18n } = await import('../../../../apps/desktop/src/i18n/runtime')
const { UI_EVENTS } = await import('../../../../apps/desktop/src/lib/uiEvents')

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  await i18n.changeLanguage('zh-CN')
})
afterEach(() => { progress.value = null; vi.unstubAllGlobals() })

describe('Help & tour while real feature films are unavailable', () => {
  it.each([false, true])('keeps restart/resume and hides the films entry (resumable: %s)', async (resumable) => {
    progress.value = resumable ? { step: 'chats', status: 'skipped' } : null
    const h = createReactHarness()
    const requests: unknown[] = []
    const capture = (event: Event) => requests.push((event as CustomEvent).detail)
    window.addEventListener(UI_EVENTS.reopenProductTour, capture)
    try {
      await renderWithAppProviders(h, createNode(Sidebar, { activeTab: 'tasks', onTabChange: vi.fn() }))
      await clickElement(h.container.querySelector('[data-rail="help"]')!)
      const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      expect(items.some((item) => item.textContent?.includes('看功能短片'))).toBe(false)
      expect(items.some((item) => item.textContent?.includes('继续导览 3 / 7'))).toBe(resumable)
      await clickElement(items.find((item) => item.textContent?.includes('从头开始导览'))!)
      expect(requests).toEqual([{ mode: 'restart' }])
    } finally {
      window.removeEventListener(UI_EVENTS.reopenProductTour, capture)
      h.cleanup()
    }
  })
})
