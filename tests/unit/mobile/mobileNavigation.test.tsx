// @vitest-environment jsdom
import { act, createRef, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileTabPager } from '../../../apps/desktop/src/mobile/MobileTabPager'
import { navigateMobile } from '../../../apps/desktop/src/mobile/navigateMobile'
import { createNode, createReactHarness } from '../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
const tabs = ['tasks', 'chats', 'contacts', 'settings'] as const
const tabBarRef = createRef<HTMLElement>()
const scrollTo = vi.fn()
const settle = vi.fn()
let reduced = false

beforeEach(() => {
  harness = createReactHarness()
  tabBarRef.current = document.createElement('nav')
  reduced = false
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 390 } as DOMRect)
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo })
  Object.defineProperty(document, 'startViewTransition', { configurable: true, get: () => undefined })
})
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); delete document.documentElement.dataset.mobileDirection })

const pager = (activeTab: typeof tabs[number]) => createNode(MobileTabPager, {
  mobile: true, tabs, activeTab, swipeable: true, onSettle: settle, tabBarRef, pages: {},
})

it('a tap aligns the page and tab highlight immediately; swipes settle only at whole pages', async () => {
  await harness.render(pager('tasks'))
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: 'instant' })
  await harness.render(pager('settings'))
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 1170, behavior: 'instant' })
  expect(tabBarRef.current?.style.getPropertyValue('--gg-tab-position')).toBe('3')
  expect(settle).not.toHaveBeenCalled()
  const element = harness.container.querySelector('[data-mobile-tab-pager]') as HTMLElement
  await act(async () => { element.scrollLeft = 975; element.dispatchEvent(new Event('scroll')) })
  expect(settle).not.toHaveBeenCalled()
  expect(tabBarRef.current?.style.getPropertyValue('--gg-tab-position')).toBe('2.5')
  await act(async () => {
    element.scrollLeft = 780
    element.dispatchEvent(new Event('scroll'))
  })
  expect(settle).toHaveBeenCalledExactlyOnceWith('contacts')
})

it('reduced motion makes a clicked tab align immediately', async () => {
  reduced = true
  await harness.render(pager('tasks'))
  await harness.render(pager('settings'))
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 1170, behavior: 'instant' })
})

it('reduced motion commits a route without starting a view transition', async () => {
  await harness.render(pager('tasks'))
  reduced = true
  const start = vi.fn()
  Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start })
  const update = vi.fn()
  navigateMobile(update, 'push')
  expect(update).toHaveBeenCalledOnce()
  expect(start).not.toHaveBeenCalled()
})

it('rapid back navigation cancels the old animation and preserves the latest route', async () => {
  let navigate: (value: number | ((current: number) => number)) => void = () => undefined
  function Route() {
    const [value, setValue] = useState(0)
    navigate = (next) => navigateMobile(() => setValue(next), next === 0 ? 'pop' : 'push')
    return createNode('div', { 'data-mobile-tab-pager': true }, String(value))
  }
  let finish: () => void = () => undefined
  const first = { skipTransition: vi.fn(), finished: new Promise<void>((resolve) => { finish = resolve }) }
  const second = { skipTransition: vi.fn(), finished: Promise.resolve() }
  let count = 0
  const start = vi.fn((update: () => void) => { update(); return count++ === 0 ? first : second })
  Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start })
  await harness.render(createNode(Route))
  await act(async () => { navigate((value) => value + 1) })
  expect(harness.container.textContent).toBe('1')
  expect(document.documentElement.dataset.mobileDirection).toBe('push')
  await act(async () => { navigate(0) })
  expect(first.skipTransition).toHaveBeenCalledOnce()
  expect(harness.container.textContent).toBe('0')
  finish()
  await Promise.resolve()
  expect(document.documentElement.dataset.mobileDirection).toBeUndefined()
})
