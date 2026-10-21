import { act } from 'react'
import { expect, vi } from 'vitest'

// jsdom has no CSS animation clock. Keep Base UI's real lifecycle waiting on a
// browser-animation promise; real 200ms CSS is checked separately in the phone browser.
export function holdDialogExit() {
  let finish: () => void = () => undefined
  let pending = new Promise<void>((resolve) => { finish = resolve })
  const observed = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: function (this: HTMLElement) {
    if (!this.hasAttribute('data-ending-style')) return []
    observed(this)
    return [{ finished: pending }]
  } })
  return {
    observed,
    async finish() { await act(async () => { finish(); await pending }); pending = new Promise((resolve) => { finish = resolve }) },
  }
}
export async function frame() {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
}
export async function expectExit(element: HTMLElement, exit: ReturnType<typeof holdDialogExit>) {
  await frame()
  expect(element.isConnected).toBe(true)
  expect(element.hasAttribute('data-ending-style')).toBe(true)
  expect(exit.observed).toHaveBeenCalledWith(element)
  await exit.finish()
  expect(element.isConnected).toBe(false)
}
