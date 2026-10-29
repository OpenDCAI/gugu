// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachmentSendTiming, attachmentUploadTimeoutMs, AttachmentStageTimeout } from '../../../../apps/desktop/src/lib/attachmentSendTiming'

vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }))
afterEach(() => vi.useRealTimers())

describe('attachment upload inactivity (#1002)', () => {
  it('does not count repeated zero-byte events as progress', async () => {
    vi.useFakeTimers()
    let progress!: (sent: number) => void
    const done = attachmentSendTiming('m', 'c').stage('upload', 1,
      (_signal, _cap, report) => { progress = report; return new Promise(() => {}) }).catch(error => error)
    await vi.advanceTimersByTimeAsync(1)
    for (let i = 0; i < 2; i++) { await vi.advanceTimersByTimeAsync(5000); progress(0) }
    await vi.advanceTimersByTimeAsync(5000)
    expect(await done).toBeInstanceOf(AttachmentStageTimeout)
  })
  it('fails a 1 MiB attempt promptly when it never makes any progress', async () => {
    vi.useFakeTimers()
    let outcome: unknown = 'pending'
    const done = attachmentSendTiming('message', 'chat').stage('upload', 1,
      () => new Promise(() => {}), undefined, { timeoutMs: attachmentUploadTimeoutMs(1_048_576) })
      .catch(error => { outcome = error })
    await vi.advanceTimersByTimeAsync(15_001)
    expect(outcome).toBeInstanceOf(AttachmentStageTimeout)
    await done
  })

  it('keeps the size allowance while bytes continue advancing, then fails when they stop', async () => {
    vi.useFakeTimers()
    let progress!: (sent: number) => void
    let outcome: unknown = 'pending'
    const done = attachmentSendTiming('message', 'chat').stage('upload', 1,
      (_signal, _cap, report) => { progress = report; return new Promise(() => {}) },
      undefined, { timeoutMs: attachmentUploadTimeoutMs(1_048_576) })
      .catch(error => { outcome = error })
    await vi.advanceTimersByTimeAsync(1)
    for (let sent = 1; sent <= 5; sent++) {
      await vi.advanceTimersByTimeAsync(10_000)
      progress(sent * 64 * 1024)
      expect(outcome).toBe('pending')
    }
    await vi.advanceTimersByTimeAsync(15_001)
    expect(outcome).toBeInstanceOf(AttachmentStageTimeout)
    await done
  })
})
