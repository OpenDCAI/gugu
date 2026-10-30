/** @jsxImportSource solid-js */
import { render } from 'solid-js/web'
import { ANIMATION_WINDOW_SEEN_EVENT } from '@gugu/session-shared/animation-visibility'
import '@gugu/session-shared/animation-visibility.css'
import { GridLoader } from '@session-chat/components/primitives/GridLoader'
import { afterEach, expect, it, vi } from 'vitest'
import { until } from '../../../../tests/support/awaitCondition'

/**
 * Root contract: the running grid loader is CSS only. Its nine dots carry their own opacity keyframes and run on the
 * compositor; nothing on the main thread steps it, and it holds still whenever it cannot be seen.
 * (It used to swap classes from a 120 ms setInterval, which kept the whole window producing frames.)
 */
const teardown: Array<() => void> = []
afterEach(() => {
  while (teardown.length) teardown.pop()?.()
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }))
})

it('runs on CSS keyframes alone and pauses while its window is not seen', async () => {
  const timers = vi.spyOn(window, 'setInterval')
  const host = document.createElement('div')
  document.body.append(host)
  teardown.push(render(() => <GridLoader />, host), () => host.remove())

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
