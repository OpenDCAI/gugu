// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePhoneRead, type PhoneRead } from '../../../apps/desktop/src/mobile/assistant/usePhoneRead'
import { createNode, createReactHarness, deferred } from '../../support/testHarness'

// 悄悄重读(语音笔记还在处理时每隔几秒再问一次)偶尔失败一次,不该让它从此不再刷新:
// 否则「处理中」的笔记永远停在处理中(code-review #7277 第 2 条)。
let latest: (PhoneRead<string> & { refresh: () => Promise<void> }) | null = null
function Probe({ read, pollMs }: { read: () => Promise<string>; pollMs: (data: string) => number | null }) {
  latest = usePhoneRead('key', read, 'test', pollMs)
  return null
}

describe('usePhoneRead polling', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    vi.useFakeTimers()
    harness = createReactHarness()
    latest = null
  })
  afterEach(() => {
    harness.cleanup()
    vi.useRealTimers()
  })

  it('keeps polling after a quiet re-read fails, and keeps the last good read meanwhile', async () => {
    const read = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('processing')
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce('done')
    await harness.render(createNode(Probe, { read, pollMs: (data: string) => (data === 'processing' ? 1000 : null) }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(latest).toEqual(expect.objectContaining({ state: 'ok', data: 'processing' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(read, 'the quiet re-read ran and failed').toHaveBeenCalledTimes(2)
    expect(latest, 'a failed quiet re-read leaves the last read in place').toEqual(expect.objectContaining({ state: 'ok', data: 'processing' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(read, 'polling went on after the failure').toHaveBeenCalledTimes(3)
    expect(latest).toEqual(expect.objectContaining({ state: 'ok', data: 'done' }))
  })

  it('says so when the first read fails (not a quiet one)', async () => {
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('network'))
    await harness.render(createNode(Probe, { read, pollMs: () => 1000 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(latest?.state).toBe('error')
  })

  it('does not let an earlier poll replace the verified result after a mutation', async () => {
    const poll = deferred<string>()
    const read = vi.fn<() => Promise<string>>()
      .mockResolvedValueOnce('old')
      .mockReturnValueOnce(poll.promise)
      .mockResolvedValueOnce('updated')
    await harness.render(createNode(Probe, { read, pollMs: (data: string) => data === 'old' ? 1000 : null }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => { await latest!.refresh() })
    expect(latest).toMatchObject({ state: 'ok', data: 'updated' })
    await act(async () => { poll.resolve('stale') })
    expect(latest).toMatchObject({ state: 'ok', data: 'updated' })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('reports an explicitly requested refresh failure instead of claiming verification succeeded', async () => {
    const read = vi.fn<() => Promise<string>>().mockResolvedValueOnce('old').mockRejectedValueOnce(new Error('verification unavailable'))
    await harness.render(createNode(Probe, { read, pollMs: () => null }))
    await act(async () => { await expect(latest!.refresh()).rejects.toThrow('verification unavailable') })
    expect(latest?.state).toBe('error')
  })
})
