/** @jsxImportSource solid-js */
import { render } from 'solid-js/web'
import { ANIMATION_WINDOW_SEEN_EVENT } from '@gugu/session-shared/animation-visibility'
import '@gugu/session-shared/animation-visibility.css'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cdp } from 'vitest/browser'
import { until } from '../../../../tests/support/awaitCondition'

/**
 * Root contract: the running grid loader is CSS only. Its nine dots carry their own opacity keyframes and run on the
 * compositor; nothing on the main thread steps it, and it holds still whenever it cannot be seen — window or viewport.
 * (It used to swap classes from a 120 ms setInterval, which kept the whole window producing frames.)
 *
 * Viewport visibility is driven explicitly: the runner may host this file in an iframe that is not on screen, where the
 * real IntersectionObserver rightly reports "not intersecting" and the loader rightly stays paused.
 */
// The page's own visibility is pinned too (a background runner tab may report hidden); the window-seen event is the
// switch under test.
vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
const observers: Array<{ callback: IntersectionObserverCallback; targets: Element[] }> = []
vi.stubGlobal('IntersectionObserver', class {
  private readonly entry: { callback: IntersectionObserverCallback; targets: Element[] }
  constructor(callback: IntersectionObserverCallback) { this.entry = { callback, targets: [] }; observers.push(this.entry) }
  observe(target: Element) { this.entry.targets.push(target) }
  unobserve(target: Element) { this.entry.targets = this.entry.targets.filter((t) => t !== target) }
  disconnect() { this.entry.targets = [] }
})
const inViewport = (isIntersecting: boolean) => {
  for (const { callback, targets } of observers) callback(targets.map((target) => ({ target, isIntersecting }) as unknown as IntersectionObserverEntry), {} as IntersectionObserver)
}
const { GridLoader } = await import('@session-chat/components/primitives/GridLoader')

type Cdp = { send: (method: string, params: object) => Promise<unknown> }
/** The real media feature, set on the browser as the OS setting would be; a CI runner's own default must not decide. */
async function reducedMotion(value: 'reduce' | 'no-preference' | null) {
  await (cdp() as unknown as Cdp).send('Emulation.setEmulatedMedia', { features: value ? [{ name: 'prefers-reduced-motion', value }] : [] })
  if (value) await until(`the page reads prefers-reduced-motion: ${value}`, () => matchMedia(`(prefers-reduced-motion: ${value})`).matches)
}
const teardown: Array<() => void> = []
beforeEach(() => reducedMotion('no-preference'))
afterEach(async () => {
  while (teardown.length) teardown.pop()?.()
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }))
  await reducedMotion(null)
})

it('runs on CSS keyframes alone and pauses with its window and when it leaves the viewport', async () => {
  const timers = vi.spyOn(window, 'setInterval')
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }))
  const host = document.createElement('div')
  document.body.append(host)
  teardown.push(render(() => <GridLoader />, host), () => host.remove())

  const animations = () => [...host.querySelectorAll('[data-slot=grid-loader] i')].flatMap((cell) => cell.getAnimations())
  await until('nine dots carry an animation', () => animations().length === 9)
  for (const animation of animations()) expect(animation.effect!.getComputedTiming().iterations).toBe(Infinity)
  expect(timers).not.toHaveBeenCalled()
  inViewport(true)
  await until('in view and seen, every dot runs', () => animations().every((a) => a.playState === 'running'))

  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }))
  await until('every dot pauses with the window', () => animations().every((a) => a.playState === 'paused'))
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }))
  await until('and runs again when it is seen', () => animations().every((a) => a.playState === 'running'))

  inViewport(false)
  await until('out of the viewport, every dot pauses', () => animations().every((a) => a.playState === 'paused'))
  inViewport(true)
  await until('back in view, every dot runs', () => animations().every((a) => a.playState === 'running'))
  expect(timers).not.toHaveBeenCalled()
})

it('with reduced motion the dots hold the first frame and nothing runs', async () => {
  await reducedMotion('reduce')
  const host = document.createElement('div')
  document.body.append(host)
  teardown.push(render(() => <GridLoader />, host), () => host.remove())
  const cells = [...host.querySelectorAll<HTMLElement>('[data-slot=grid-loader] i')]
  expect(cells).toHaveLength(9)
  expect(cells.flatMap((cell) => cell.getAnimations())).toHaveLength(0)
  // first frame of the pattern: dots 0, 4 and 5 lit
  expect(cells.map((cell) => getComputedStyle(cell).opacity)).toEqual(['0.9', '0.15', '0.15', '0.15', '0.9', '0.9', '0.15', '0.15', '0.15'])
})
