// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, waitForCondition } from '../../../support/testHarness'

const io = vi.hoisted(() => ({ save: vi.fn(async (): Promise<void> => undefined) }))
vi.mock('../../../../apps/desktop/src/lib/productTour', async (original) => ({
  ...await original<Record<string, unknown>>(), saveProductTourState: io.save, useRememberProductTourState: () => () => undefined,
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: {} }))
// The primitive owns floating geometry; this suite measures the workflow, not jsdom's zero-sized layout.
vi.mock('../../../../apps/desktop/src/components/ui/Popover', () => ({
  Popover: { Arrow: () => createNode('i', { 'data-testid': 'tour-arrow' }), Root: ({ children }: { children: unknown }) => children, Portal: ({ children }: { children: unknown }) => children,
    Positioner: ({ children }: { children: unknown }) => children,
    Popup: ({ children, ...props }: { children: unknown; 'data-testid'?: string; role?: string }) => createNode('section', { 'data-testid': props['data-testid'], role: props.role }, children as never) },
}))
const { ProductTour } = await import('../../../../apps/desktop/src/components/productTour/ProductTour')
const { i18n } = await import('../../../../apps/desktop/src/i18n/runtime')

const box = (x: number, y: number, width: number, height: number) => () => ({ width, height, x, y, top: y, left: x, right: x + width, bottom: y + height, toJSON() {} }) as DOMRect
let rail: HTMLElement
beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  await i18n.changeLanguage('zh-CN')
  rail = document.createElement('nav')
  rail.className = 'gg-sidebar-rail'
  for (const [i, name] of ['assistant', 'chats', 'contacts', 'library', 'apps', 'settings'].entries()) {
    const button = document.createElement('button')
    button.dataset.rail = name
    button.getBoundingClientRect = box(0, 20 + i * 48, 40, 40)
    button.scrollIntoView = vi.fn()
    rail.append(button)
  }
  for (const page of ['projects', 'chats']) {
    const button = document.createElement('button')
    button.dataset.testid = `sidebar-list-page-${page}`
    button.getBoundingClientRect = box(60, 20, 80, 32)
    button.scrollIntoView = vi.fn()
    rail.append(button)
  }
  document.body.append(rail)
})
afterEach(() => { rail.remove(); document.querySelector('[data-tour="sample-project"]')?.remove(); vi.clearAllMocks(); vi.unstubAllGlobals() })

const STEPS = ['assistant', 'tasks', 'chats', 'contacts', 'library', 'apps', 'settings'] as const
async function mount(start: (typeof STEPS)[number] = 'assistant', steps: readonly string[] = STEPS) {
  const harness = createReactHarness()
  const done = vi.fn()
  await harness.render(createNode(ProductTour, { userId: 'owner-1', steps, start, onDone: done }))
  await waitForCondition(() => !!document.querySelector('[data-testid^="product-tour-step-"]'), 'card shown')
  const button = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="product-tour-${id}"]`)
  const card = () => document.querySelector<HTMLElement>('[data-testid^="product-tour-step-"]')!
  return { ...harness, done, button, card }
}
const key = (k: string) => act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })

describe('feature-bar coach marks (onboarding spec §2)', () => {
  it('points an arrow at a real entry, spotlights it, and shows n / N with Skip and Next but no Back on step 1', async () => {
    const h = await mount()
    try {
      expect(h.card().dataset.testid).toBe('product-tour-step-assistant')
      expect(h.card().getAttribute('role')).toBe('dialog')
      expect(h.card().querySelector('[data-testid="tour-arrow"]')).not.toBeNull()
      expect(document.querySelector('[data-testid="product-tour-spotlight"]')).not.toBeNull()
      expect(h.card().textContent).toContain('1 / 7')
      expect(h.card().textContent).toContain('咕咕：你的个人助理')
      expect(h.button('previous')).toBeNull()
      expect(h.button('skip')).not.toBeNull()
      await clickElement(h.button('next')!)
      expect(h.card().textContent).toContain('2 / 7')
      expect(h.button('previous')).not.toBeNull()
      expect(io.save).toHaveBeenLastCalledWith('owner-1', { step: 'tasks', status: 'active' })
    } finally { h.cleanup() }
  })
  it('ends with Done and no Skip, and records the tour as seen', async () => {
    const h = await mount('settings')
    try {
      expect(h.card().textContent).toContain('7 / 7')
      expect(h.button('skip')).toBeNull()
      expect(h.button('next')!.textContent).toBe('完成')
      await clickElement(h.button('next')!)
      expect(h.done).toHaveBeenCalledOnce()
      expect(io.save).toHaveBeenLastCalledWith('owner-1', { step: 'settings', status: 'done' })
    } finally { h.cleanup() }
  })
  it('follows Enter, →, ← and Esc; Esc skips and remembers where it stopped', async () => {
    const h = await mount()
    try {
      await key('Enter')
      await key('ArrowRight')
      expect(h.card().textContent).toContain('3 / 7')
      await key('ArrowLeft')
      expect(h.card().textContent).toContain('2 / 7')
      await key('Escape')
      expect(h.done).toHaveBeenCalledOnce()
      expect(io.save).toHaveBeenLastCalledWith('owner-1', { step: 'tasks', status: 'skipped' })
    } finally { h.cleanup() }
  })
  it('ignores clicks on the dimmed area', async () => {
    const h = await mount()
    try {
      const shade = document.querySelector<HTMLElement>('.product-tour-shade')!
      await clickElement(shade)
      expect(h.card().textContent).toContain('1 / 7')
      expect(h.done).not.toHaveBeenCalled()
    } finally { h.cleanup() }
  })
  it('makes the projects step a do-it step when the sample project is there: no Next, opening it moves on', async () => {
    const sample = document.createElement('div')
    sample.dataset.tour = 'sample-project'
    sample.getBoundingClientRect = box(60, 200, 220, 36)
    sample.scrollIntoView = vi.fn()
    document.body.append(sample)
    const h = await mount('tasks')
    try {
      expect(h.card().textContent).toContain('点开示例项目，看看一件事是怎么推进的。')
      expect(h.button('next')).toBeNull()
      expect(h.button('skip')).not.toBeNull()
      expect(h.button('previous')).not.toBeNull()
      await key('Enter')
      expect(h.card().textContent).toContain('2 / 7')
      await clickElement(sample)
      await waitForCondition(() => h.card().textContent!.includes('3 / 7'), 'advanced by opening the sample')
    } finally { h.cleanup() }
  })
  it('counts only the steps it was given', async () => {
    const h = await mount('assistant', ['assistant', 'tasks', 'chats', 'contacts', 'settings'])
    try { expect(h.card().textContent).toContain('1 / 5') } finally { h.cleanup() }
  })
})
