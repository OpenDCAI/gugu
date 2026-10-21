// @vitest-environment jsdom
// #5610 §2.5:主界面的中间错误边界 —— 兜底,不是修复。这里钉的是它「兜住的范围」和「不许静默」两件事。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { ShellErrorBoundary } from '../../../../apps/desktop/src/components/ShellErrorBoundary'

let explode = true
function Bomb() {
  if (explode) throw new Error('shell exploded')
  return createNode('div', { 'data-testid': 'shell-ok' })
}

describe('ShellErrorBoundary', () => {
  let consoleError: ReturnType<typeof vi.spyOn>
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    explode = true
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    harness = createReactHarness()
  })
  afterEach(() => {
    harness.cleanup()
    consoleError.mockRestore()
  })

  it('confines a shell render throw: fallback replaces the shell, siblings outside the boundary stay mounted, and the crash is logged loudly', async () => {
    await harness.render(createNode('div', null,
      createNode(ShellErrorBoundary, null, createNode(Bomb)),
      createNode('div', { 'data-testid': 'sibling-host' }),
    ))
    expect(document.body.querySelector('[data-testid="shell-error-fallback"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="sibling-host"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="shell-ok"]')).toBeNull()
    // 兜住 ≠ 修好:必须留下痕迹(rendererLogger 在非 Electron 环境退化成 console.error(`[scope] msg`, fields))。
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[app/shell-boundary]'),
      expect.objectContaining({ err: expect.stringContaining('shell exploded'), attempt: 0 }),
    )
  })

  it('retry remounts the shell instead of reloading the window', async () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } })
    await harness.render(createNode(ShellErrorBoundary, null, createNode(Bomb)))
    const buttons = [...document.body.querySelectorAll('[data-testid="shell-error-fallback"] button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['重试', '重新加载'])
    explode = false
    await act(async () => { (buttons[0] as HTMLButtonElement).click() })
    expect(document.body.querySelector('[data-testid="shell-ok"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="shell-error-fallback"]')).toBeNull()
    expect(reload).not.toHaveBeenCalled()
  })
})
