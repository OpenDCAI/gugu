// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CopyValue } from '@/components/CopyValue'
import { platform } from '@/platform'
import { notifyCopied } from '@/lib/copyFeedback'
import { notify } from '@/lib/notices'
import { clickElement, createReactHarness, deferred, renderWithAppProviders } from '../../../support/testHarness'

const shell = vi.hoisted(() => ({ mobile: true }))
vi.mock('@/hooks/useMobileShell', () => ({ readMobileShell: () => shell.mobile, useMobileShell: () => shell.mobile }))
vi.mock('@/lib/notices', () => ({ notify: vi.fn() }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { shell.mobile = true; harness = createReactHarness(); vi.mocked(notify).mockClear() })
afterEach(() => { harness.cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('mobile copy confirmation', () => {
  it('uses one compact 1.5 second notice for a menu, while desktop keeps its existing notice', () => {
    notifyCopied('Copied')
    expect(notify).toHaveBeenLastCalledWith({ title: 'Copied', tier: 'success', key: 'clipboard-copy', duration: 1500, presentation: 'compact' })
    shell.mobile = false
    notifyCopied('Copied')
    expect(notify).toHaveBeenLastCalledWith({ title: 'Copied', tier: 'success' })
  })

  it('waits for the write, changes the persistent button to a checkmark, and clears it without a toast', async () => {
    vi.useFakeTimers()
    const write = deferred<void>(), toast = vi.fn()
    const native = vi.spyOn(platform, 'writeClipboardText').mockReturnValue(write.promise)
    await renderWithAppProviders(harness, <CopyValue value="exact text" message="Copied" />, { toast })
    const button = harness.container.querySelector('button')!
    await clickElement(button)
    expect(native).toHaveBeenCalledExactlyOnceWith('exact text')
    expect(button.hasAttribute('data-copied')).toBe(false)
    await act(async () => write.resolve())
    expect(button.getAttribute('data-copied')).toBe('true')
    expect(button.getAttribute('aria-label')).toBe('Copied')
    expect(toast).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(1499) })
    expect(button.hasAttribute('data-copied')).toBe(true)
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(button.hasAttribute('data-copied')).toBe(false)
  })

  it.each(['toast', 'inline'] as const)('does not claim success when the native clipboard rejects (%s)', async feedback => {
    const toast = vi.fn()
    vi.spyOn(platform, 'writeClipboardText').mockRejectedValue(new Error('Native clipboard refused'))
    await renderWithAppProviders(harness, <CopyValue value="exact text" message="Copied" feedback={feedback} />, { toast })
    await clickElement(harness.container.querySelector('button')!)
    expect(harness.container.querySelector('[data-copied]')).toBeNull()
    if (feedback === 'inline') {
      expect(harness.container.querySelector('[aria-live]')?.textContent).toBe('Native clipboard refused')
      expect(toast).not.toHaveBeenCalled()
    } else expect(toast).toHaveBeenCalledWith(expect.any(String), 'error', 'Native clipboard refused')
    expect(notify).not.toHaveBeenCalled()
  })
})
