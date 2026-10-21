// #7348 本机开通没在等的时间里走完(新电脑第一次装,要先下载连 Claude 的组件):壳接着推完,它才会先开口。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProvisionResumeRecord } from '../../../../apps/desktop/src/lib/agentProvision'
import {
  FINISH_RETRY_FIRST_MS,
  FINISH_RETRY_MAX_MS,
  keepFinishingLocalAssistant,
  type FinishLocalAssistantDeps,
} from '../../../../apps/desktop/src/lib/assistantSetupFinish'

const record = { operationId: 'op-1' } as unknown as ProvisionResumeRecord
const stillStarting = new Error('assistant is still starting on this computer')
const failed = new Error('agent.create failed')

function deps(overrides: Partial<FinishLocalAssistantDeps> = {}): FinishLocalAssistantDeps {
  return {
    pending: vi.fn(() => record),
    resume: vi.fn(async () => undefined),
    isFinal: (error) => error === failed,
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    warn: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('keep finishing the local assistant setup (#7348)', () => {
  it('does nothing when nothing is left unfinished on this computer', async () => {
    const d = deps({ pending: vi.fn(() => null) })
    keepFinishingLocalAssistant(d)
    await vi.runAllTimersAsync()
    expect(d.resume).not.toHaveBeenCalled()
  })

  it('keeps pushing while it is still starting, then stops once the setup completes', async () => {
    const resume = vi.fn<FinishLocalAssistantDeps['resume']>()
      .mockRejectedValueOnce(stillStarting)
      .mockRejectedValueOnce(stillStarting)
      .mockResolvedValueOnce(undefined)
    const d = deps({ resume })
    keepFinishingLocalAssistant(d)
    await vi.advanceTimersByTimeAsync(0)
    expect(resume).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(FINISH_RETRY_FIRST_MS)
    expect(resume).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(FINISH_RETRY_FIRST_MS * 2)
    expect(resume).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(FINISH_RETRY_MAX_MS * 4)
    expect(resume).toHaveBeenCalledTimes(3)
    expect(resume).toHaveBeenCalledWith(record)
  })

  it('gives up on a final failure (pushing again would fail the same way) and says why in the log', async () => {
    const resume = vi.fn<FinishLocalAssistantDeps['resume']>().mockRejectedValue(failed)
    const d = deps({ resume })
    keepFinishingLocalAssistant(d)
    await vi.advanceTimersByTimeAsync(FINISH_RETRY_MAX_MS * 4)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(d.warn).toHaveBeenCalledWith({ error: String(failed) }, 'finish local assistant setup failed')
  })

  it('backs off 15s → 30s → 60s → 120s and stays at 120s', async () => {
    const resume = vi.fn<FinishLocalAssistantDeps['resume']>().mockRejectedValue(stillStarting)
    keepFinishingLocalAssistant(deps({ resume }))
    await vi.advanceTimersByTimeAsync(0)
    const gaps = [15_000, 30_000, 60_000, 120_000, 120_000]
    for (const [i, gap] of gaps.entries()) {
      await vi.advanceTimersByTimeAsync(gap - 1)
      expect(resume).toHaveBeenCalledTimes(i + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(resume).toHaveBeenCalledTimes(i + 2)
    }
  })

  it('stopping (shell unmounts / account switch) cancels the scheduled retry', async () => {
    const resume = vi.fn<FinishLocalAssistantDeps['resume']>().mockRejectedValue(stillStarting)
    const stop = keepFinishingLocalAssistant(deps({ resume }))
    await vi.advanceTimersByTimeAsync(0)
    stop()
    await vi.advanceTimersByTimeAsync(FINISH_RETRY_MAX_MS * 4)
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('an unreadable pending record is logged, not treated as "nothing to do" silently or retried blindly', async () => {
    const d = deps({ pending: vi.fn(() => { throw new Error('bad record') }) })
    keepFinishingLocalAssistant(d)
    await vi.runAllTimersAsync()
    expect(d.resume).not.toHaveBeenCalled()
    expect(d.warn).toHaveBeenCalledWith({ error: 'Error: bad record' }, 'read pending local assistant failed')
  })
})
