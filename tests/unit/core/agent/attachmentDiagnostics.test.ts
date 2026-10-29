import { afterEach, expect, it, vi } from 'vitest'
import { setCoreLoggerFactory } from '@gugu/core/log'
import { attachmentStage, attachmentFailureReason } from '@gugu/core/local/files/attachmentDiagnostics'

afterEach(() => { vi.useRealTimers() })

it('logs the failed stage and elapsed time, keeping nested network causes without swallowing the error', async () => {
  vi.useFakeTimers()
  const warn = vi.fn(), info = vi.fn()
  const restore = setCoreLoggerFactory(() => ({ warn, info, debug: vi.fn(), error: vi.fn() }))
  const network = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
  const failure = new Error('fetch failed', { cause: network })
  const context = { messageId: 'message', actorId: 'agent' }
  try {
    const start = Date.now()
    await expect(attachmentStage(context, 'resolve', async () => {
      vi.setSystemTime(start + 137)
      throw failure
    })).rejects.toBe(failure)
    expect(warn).toHaveBeenCalledWith({ ...context, stage: 'resolve', elapsedMs: 137,
      err: 'fetch failed: connection reset (ECONNRESET)' }, 'attachment stage failed')
    expect(await attachmentStage(context, 'save', async () => 'saved')).toBe('saved')
    expect(info).toHaveBeenCalledWith({ ...context, stage: 'save', elapsedMs: 0 }, 'attachment stage completed')
  } finally { restore() }
})

it('handles non-Error failures and cyclic causes', () => {
  expect(attachmentFailureReason('HTTP 503')).toBe('HTTP 503')
  const error = new Error('cycle'); error.cause = error
  expect(attachmentFailureReason(error)).toBe('cycle')
})
