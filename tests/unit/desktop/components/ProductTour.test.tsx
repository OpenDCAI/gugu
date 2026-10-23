// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, waitForCondition } from '../../../support/testHarness'

const io = vi.hoisted(() => ({
  saveProductTourPosition: vi.fn(async (): Promise<void> => undefined),
  finishFirstRun: vi.fn(async () => '2026-10-20T00:00:00Z'),
}))
vi.mock('../../../../apps/desktop/src/lib/firstRun', () => ({ finishFirstRun: io.finishFirstRun }))
vi.mock('../../../../apps/desktop/src/lib/productTour', async (original) => ({ ...await original<Record<string, unknown>>(), saveProductTourPosition: io.saveProductTourPosition }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: {} }))
// The primitive owns floating geometry and dismissal; this suite measures the workflow, not jsdom's zero-sized layout.
vi.mock('../../../../apps/desktop/src/components/ui/Popover', () => ({
  Popover: { Arrow: () => null, Root: ({ children }: { children: unknown }) => children, Portal: ({ children }: { children: unknown }) => children,
    Positioner: ({ children }: { children: unknown }) => children,
    Popup: ({ children }: { children: unknown }) => createNode('section', { 'aria-label': 'tour' }, children as never) },
}))
const { ProductTour } = await import('../../../../apps/desktop/src/components/productTour/ProductTour')
const { i18n } = await import('../../../../apps/desktop/src/i18n/runtime')

async function mount(initial: { phase: 'modules' | 'features'; index: number } = { phase: 'modules', index: 0 }) {
  await i18n.changeLanguage('zh-CN')
  const rail = document.createElement('nav')
  rail.className = 'gg-sidebar-rail'
  const clicks: string[] = []
  for (const name of ['assistant', 'chats', 'contacts', 'library', 'apps', 'settings']) {
    const button = document.createElement('button')
    button.dataset.rail = name
    button.getBoundingClientRect = () => ({ width: 40, height: 40, x: 0, y: 20, top: 20, left: 0, right: 40, bottom: 60, toJSON() {} })
    button.scrollIntoView = vi.fn()
    button.onclick = () => { clicks.push(name) }
    rail.append(button)
  }
  for (const page of ['projects', 'chats']) {
    const button = document.createElement('button')
    button.dataset.testid = `sidebar-list-page-${page}`
    button.getBoundingClientRect = () => ({ width: 80, height: 32, x: 60, y: 20, top: 20, left: 60, right: 140, bottom: 52, toJSON() {} })
    button.scrollIntoView = vi.fn()
    button.onclick = () => { clicks.push(`page:${page}`) }
    rail.append(button)
  }
  document.body.append(rail)
  const harness = createReactHarness()
  const done = vi.fn()
  await harness.render(createNode(ProductTour, { userId: 'owner-1', initial, onDone: done }))
  const button = (label: string) => [...harness.container.querySelectorAll('button')].find((node) => node.textContent === label)!
  return { ...harness, done, button, clicks, cleanup() { harness.cleanup(); rail.remove() } }
}

afterEach(() => vi.clearAllMocks())

describe('native first-login module tour', () => {
  it('keeps navigation available while a slow save is pending and serializes writes', async () => {
    let release!: () => void
    io.saveProductTourPosition.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const h = await mount()
    try {
      await clickElement(h.button('下一步'))
      expect(h.button('下一步').disabled).toBe(false)
      await clickElement(h.button('下一步'))
      expect(h.container.textContent).toContain('3 / 7')
      expect(h.clicks).toEqual(['assistant', 'chats', 'page:projects', 'chats', 'page:chats'])
      expect(io.saveProductTourPosition).toHaveBeenCalledTimes(1)
      release()
      await waitForCondition(() => io.saveProductTourPosition.mock.calls.length === 2, 'queued save starts')
      expect(io.saveProductTourPosition).toHaveBeenLastCalledWith('owner-1', { phase: 'modules', index: 2 })
    } finally { release(); h.cleanup() }
  })
  it('enters the real module immediately while persisting the new position', async () => {
    const h = await mount()
    try {
      expect(h.clicks).toEqual(['assistant'])
      await clickElement(h.button('下一步'))
      await waitForCondition(() => h.clicks.includes('page:projects'), 'project navigation')
      expect(io.saveProductTourPosition).toHaveBeenCalledWith('owner-1', { phase: 'modules', index: 1 })
      expect(h.container.textContent).toContain('项目 · 集中推进一件事')
      expect(io.finishFirstRun).not.toHaveBeenCalled()
    } finally { h.cleanup() }
  })
  it('restores the saved position instead of restarting at the assistant', async () => {
    const h = await mount({ phase: 'modules', index: 3 })
    try { expect(h.clicks).toEqual(['contacts']); expect(h.container.textContent).toContain('4 / 7') } finally { h.cleanup() }
  })
  it('a failed save stays on the same module and exposes a retryable error', async () => {
    io.saveProductTourPosition.mockRejectedValueOnce(new Error('offline'))
    const h = await mount()
    try {
      await clickElement(h.button('下一步'))
      await waitForCondition(() => !!h.container.querySelector('[role=alert]'), 'visible save error')
      // The optimistic navigation is briefly followed by a rollback when the save fails.
      expect(h.clicks).toEqual(['assistant', 'chats', 'page:projects', 'assistant'])
      expect(h.container.textContent).not.toContain('offline')
      await clickElement(h.button('下一步'))
      await waitForCondition(() => h.clicks.includes('page:projects'), 'retry advances')
    } finally { h.cleanup() }
  })
  it('waits for a pending position save before completing the tour', async () => {
    let release!: () => void
    io.saveProductTourPosition.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const h = await mount()
    try {
      await clickElement(h.button('下一步'))
      await clickElement(h.button('跳过引导'))
      expect(io.finishFirstRun).not.toHaveBeenCalled()
      expect(h.done).not.toHaveBeenCalled()
      release()
      await waitForCondition(() => h.done.mock.calls.length === 1, 'completion follows the pending save')
      expect(io.finishFirstRun).toHaveBeenCalledTimes(1)
    } finally { release(); h.cleanup() }
  })
  it('skip only dismisses after the account completion write succeeds', async () => {
    io.finishFirstRun.mockRejectedValueOnce(new Error('offline'))
    const h = await mount()
    try {
      await clickElement(h.button('跳过引导'))
      expect(h.done).not.toHaveBeenCalled()
      expect(h.container.querySelector('[role=alert]')).not.toBeNull()
      await clickElement(h.button('跳过引导'))
      await waitForCondition(() => h.done.mock.calls.length === 1, 'completion acknowledged')
    } finally { h.cleanup() }
  })
})
