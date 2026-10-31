import { afterEach, describe, expect, it, vi } from 'vitest'

import { PlaywrightDeadlineReporter } from '../../../scripts/playwright-deadline-reporter.mts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Playwright deadline reporter', () => {
  it('sends SIGINT at the soft deadline and SIGKILL only after the grace period', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const signal = vi.fn()
    const reporter = new PlaywrightDeadlineReporter({
      env: {
        GUGU_PLAYWRIGHT_SOFT_TIMEOUT_MS: '1000',
        GUGU_PLAYWRIGHT_KILL_AFTER_MS: '2000',
      },
      signal,
    })

    reporter.onBegin()
    vi.advanceTimersByTime(999)
    expect(signal).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(signal).toHaveBeenCalledTimes(1)
    expect(signal).toHaveBeenLastCalledWith('SIGINT')
    vi.advanceTimersByTime(1999)
    expect(signal).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(signal).toHaveBeenLastCalledWith('SIGKILL')
  })

  it('cancels the hard deadline after reporters finish', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const signal = vi.fn()
    const reporter = new PlaywrightDeadlineReporter({
      env: {
        GUGU_PLAYWRIGHT_SOFT_TIMEOUT_MS: '1000',
        GUGU_PLAYWRIGHT_KILL_AFTER_MS: '2000',
      },
      signal,
    })

    reporter.onBegin()
    vi.advanceTimersByTime(1000)
    reporter.onEnd()
    vi.advanceTimersByTime(2000)
    expect(signal.mock.calls).toEqual([['SIGINT']])
  })

  it('fails loudly on incomplete or invalid deadline configuration', () => {
    expect(() => new PlaywrightDeadlineReporter({
      env: { GUGU_PLAYWRIGHT_SOFT_TIMEOUT_MS: '1000' },
    }).onBegin()).toThrow('requires both')
    expect(() => new PlaywrightDeadlineReporter({
      env: {
        GUGU_PLAYWRIGHT_SOFT_TIMEOUT_MS: '0',
        GUGU_PLAYWRIGHT_KILL_AFTER_MS: '2000',
      },
    }).onBegin()).toThrow('positive integer')
  })
})
