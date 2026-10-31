import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHostResumeHandler, installNativeSleepActivity, watchHostResumeGap } from '../../../../apps/desktop/electron/server/host-resume'
import { runResume } from '../../../../apps/desktop/electron/server/resume-cli'
import { callAccountProcess } from '../../../../apps/desktop/electron/server/account-call'
import { HOST_RESUME_CALL } from '../../../../apps/desktop/electron/session/main/core/pty/attach/attach-protocol'
import { startPtyAttachServer } from '../../../../apps/desktop/electron/session/main/core/pty/attach/attach-server'
import type { ServerAccount } from '../../../../apps/desktop/electron/server/server-layout'

afterEach(() => vi.useRealTimers())

describe('retained account resume', () => {
  it('attests native suspend/resume only, never an unpaired resume or a wall-clock stall', () => {
    const listeners = new Map<string, () => void>(), record = vi.fn()
    let now = 1000
    installNativeSleepActivity({ on: (event, callback) => listeners.set(event, callback) }, record, () => now)
    listeners.get('resume')!()
    expect(record).not.toHaveBeenCalled()
    listeners.get('suspend')!(); now = 9000; listeners.get('resume')!()
    expect(record).toHaveBeenCalledExactlyOnceWith({ since: 1000, until: 9000, source: 'native-power' })
    now = 19000; listeners.get('resume')!()
    expect(record).toHaveBeenCalledOnce()
  })
  it('passes a confirmed suspension interval through the account command and rejects future intervals', async () => {
    const call = vi.fn(async () => ({ reply: Buffer.from('{"result":{"resumed":true}}') }))
    const account = { userId: 'owner', dataDir: '/unused', signedIn: true, email: null } as ServerAccount
    const io = { stdout: new PassThrough(), stderr: new PassThrough() }, deps = { accounts: () => [account], call }
    const since = Date.now() - 10_000
    expect(await runResume(['--account', 'owner', '--suspended-since', String(since)], io, deps)).toBe(0)
    expect(call).toHaveBeenCalledWith(account, { type: HOST_RESUME_CALL, payload: { suspendedSince: since } }, { timeoutMs: 5_000 })
    expect(await runResume(['--account', 'owner', '--suspended-since', String(Date.now() + 10_000)], io, deps)).toBe(2)
    expect(call).toHaveBeenCalledOnce()
  })
  it('starts REST catchup while realtime and credential recovery are still blocked', async () => {
    const never = new Promise<void>(() => undefined)
    const pullUnread = vi.fn(async () => undefined)
    const reconnect = vi.fn(() => never)
    const reconcile = vi.fn(() => never)
    const notifyCommands = vi.fn()
    const resume = createHostResumeHandler({ pullUnread, reconnect, reconcile, notifyCommands, observed: vi.fn(), failed: vi.fn() })
    resume('controller')
    resume('wall-clock-gap')
    expect(pullUnread).toHaveBeenCalledOnce()
    expect(reconnect).toHaveBeenCalledOnce()
    expect(reconcile).toHaveBeenCalledOnce()
    expect(notifyCommands).toHaveBeenCalledOnce()
  })

  it('still pulls unread when realtime throws synchronously, and reports the failure', () => {
    const failed = vi.fn()
    const pullUnread = vi.fn(async () => undefined)
    createHostResumeHandler({ pullUnread, reconnect: () => { throw Error('socket') }, reconcile: async () => undefined,
      notifyCommands: vi.fn(), observed: vi.fn(), failed })('controller')
    expect(pullUnread).toHaveBeenCalledOnce()
    expect(failed).toHaveBeenCalledWith('realtime', expect.any(Error))
  })

  it('detects a wall-clock jump without a channel error and does not treat normal ticks as resumes', async () => {
    vi.useFakeTimers()
    let clock = 0
    const resume = vi.fn()
    const stop = watchHostResumeGap(resume, () => clock)
    clock = 1_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(resume).not.toHaveBeenCalled()
    clock = 61_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(resume).toHaveBeenCalledExactlyOnceWith('wall-clock-gap')
    stop()
    clock = 121_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(resume).toHaveBeenCalledOnce()
  })

  it('announces resume over the real account socket, restricted to a signed-in account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-resume-'))
    const called = vi.fn()
    const server = await startPtyAttachServer(dir, { warn: vi.fn(), call: async (type) => {
      expect(type).toBe(HOST_RESUME_CALL)
      called()
      return { result: { resumed: true, pid: process.pid } }
    } })
    const account = { userId: 'owner', dataDir: dir, signedIn: true, email: null } as ServerAccount
    const io = { stdout: new PassThrough(), stderr: new PassThrough() }
    try {
      const deps = { accounts: () => [account], call: callAccountProcess }
      expect(await runResume(['--account', 'owner'], io, deps)).toBe(0)
      expect(called).toHaveBeenCalledOnce()
      expect(await runResume(['--account', 'someone-else'], io, deps)).not.toBe(0)
      expect(await runResume(['--account', 'owner', 'extra'], io, deps)).toBe(2)
      expect(called).toHaveBeenCalledOnce()
    } finally {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bounds an unresponsive local socket without restarting or falling back to another account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-resume-timeout-'))
    const server = await startPtyAttachServer(dir, { warn: vi.fn(), call: async () => new Promise(() => undefined) })
    try {
      const result = await callAccountProcess({ dataDir: dir, email: null }, { type: HOST_RESUME_CALL, payload: {} }, { timeoutMs: 20 })
      expect(result).toMatchObject({ code: expect.any(Number), message: '账号进程没有及时应答' })
    } finally {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
