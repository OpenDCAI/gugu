/** @jsxImportSource solid-js */
import { render } from 'solid-js/web'
import { ANIMATION_WINDOW_SEEN_EVENT } from '@gugu/session-shared/animation-visibility'
import '@gugu/session-shared/animation-visibility.css'
import { GridLoader } from '@session-chat/components/primitives/GridLoader'
import { afterEach, expect, it, vi } from 'vitest'
import { cdp } from 'vitest/browser'
import { until } from '../../../../tests/support/awaitCondition'

/**
 * Root contract: the running grid loader is CSS only. Its nine dots carry their own opacity keyframes and run on the
 * compositor; nothing on the main thread steps it, and it holds still whenever it cannot be seen.
 * (It used to swap classes from a 120 ms setInterval, which kept the whole window producing frames.)
 */
const teardown: Array<() => void> = []
afterEach(async () => {
  while (teardown.length) teardown.pop()?.()
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }))
  vi.restoreAllMocks()
  await cdp().send('Emulation.setEmulatedMedia', { features: [] })
})

it('pauses offscreen and resumes without replacing its animations', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  teardown.push(render(() => <GridLoader />, host), () => host.remove())
  const animations = () => [...host.querySelectorAll('i')].flatMap(cell => cell.getAnimations())
  await until('dots run', () => animations().length === 9 && animations().every(a => a.playState === 'running'))
  const first = animations()[0]
  host.style.cssText = 'position:fixed;top:20000px'
  await until('offscreen dots pause', () => animations().every(a => a.playState === 'paused'))
  host.style.cssText = ''
  await until('visible dots resume', () => animations().every(a => a.playState === 'running'))
  expect(animations()[0]).toBe(first)
})

it('shows the original first-frame pattern without animation under reduced motion', async () => {
  await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  const host = document.createElement('div')
  document.body.append(host)
  teardown.push(render(() => <GridLoader />, host), () => host.remove())
  const cells = [...host.querySelectorAll('i')]
  expect(cells).toHaveLength(9)
  expect(cells.flatMap(cell => cell.getAnimations())).toHaveLength(0)
  expect(cells.map(cell => Number(getComputedStyle(cell).opacity))).toEqual([0.9, 0.15, 0.15, 0.15, 0.9, 0.9, 0.15, 0.15, 0.15])
})

it('runs on CSS keyframes alone and pauses while its window is not seen', async () => {
  const timers = vi.spyOn(window, 'setInterval')
  const host = document.createElement('div')
  document.body.append(host)
  teardown.push(render(() => <GridLoader />, host), () => host.remove())

  expect(timers).not.toHaveBeenCalled()
  const cells = () => host.querySelectorAll('[data-slot=grid-loader] i')
  const animations = () => [...cells()].flatMap((cell) => cell.getAnimations())
  await until('nine dots animate', () => animations().length === 9 && animations().every((a) => a.playState === 'running'))
  for (const animation of animations()) expect(animation.effect!.getComputedTiming().iterations).toBe(Infinity)
  expect(timers).not.toHaveBeenCalled()

  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }))
  await until('every dot pauses with the window', () => animations().every((a) => a.playState === 'paused'))
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }))
  await until('and runs again when it is seen', () => animations().every((a) => a.playState === 'running'))
})
