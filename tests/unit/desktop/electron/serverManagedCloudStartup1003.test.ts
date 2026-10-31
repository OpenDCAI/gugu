import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readVersionPin, writeVersionPin } from '../../../../apps/desktop/electron/server/server-account-versions'
import { readAccountState } from '../../../../apps/desktop/electron/server/server-account-machine'
import { checkAccountBoot } from '../../../../apps/desktop/electron/server/server-selftest'
import { runMatchVersion } from '../../../../apps/desktop/electron/server/match-version-cli'
import { runSupervisor } from '../../../../apps/desktop/electron/server/server-supervisor'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: mocks.spawn }))
vi.mock('../../../../apps/desktop/electron/server/server-keeper', () => ({
  applyLoginShell: () => '/bin/sh', clearStopped: () => undefined, liveKeeperPid: () => 1,
  markStopped: () => undefined, startKeeper: () => 1, SUPERVISOR_EXIT_ALREADY_RUNNING: 9,
}))
vi.mock('../../../../apps/desktop/electron/server/server-updater', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../apps/desktop/electron/server/server-updater')>(),
  managedLayout: () => ({ home: process.env.GUGU_SERVER_HOME!, versions: path.join(process.env.GUGU_SERVER_HOME!, 'versions'), version: process.env.GUGU_TASK_HOST_VERSION! }),
  startServerUpdater: () => undefined,
}))
vi.mock('../../../../apps/desktop/electron/server/server-upgrade-guard', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../apps/desktop/electron/server/server-upgrade-guard')>(),
  ensureUpgradeGuard: () => undefined,
}))

vi.mock('../../../../apps/desktop/electron/server/server-selftest', () => ({
  checkAccountBoot: vi.fn(async () => undefined),
}))

const U = '11111111-1111-4111-8111-111111111111'
const A = '0.2.58-fc-staging.aaaaaaaa'
const B = '0.2.58-fc-staging.bbbbbbbb'
let home: string
const emitter: EventEmitter = process
let listeners: Map<string, ReturnType<EventEmitter['listeners']>>
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cloud-startup-1003-'))
  vi.stubEnv('GUGU_SERVER_HOME', home)
  vi.stubEnv('GUGU_SERVER_SUPERVISED', 'systemd')
  vi.stubEnv('GUGU_TASK_HOST_VERSION', B)
  vi.useFakeTimers()
  listeners = new Map(['exit', 'SIGTERM', 'SIGINT', 'SIGUSR2'].map((event) => [event, emitter.listeners(event)]))
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.mocked(checkAccountBoot).mockReset().mockResolvedValue(undefined)
  mocks.spawn.mockReset().mockImplementation(() => Object.assign(new EventEmitter(), { pid: 999, exitCode: null, signalCode: null, kill: vi.fn() }))
  for (const version of [A, B]) {
    const bin = path.join(home, 'versions', version, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'gugu-server'), '#!/bin/sh\n')
  }
  const data = path.join(home, 'accounts', U, 'data')
  fs.mkdirSync(data, { recursive: true })
  fs.writeFileSync(path.join(data, 'server-session.enc'), 'x')
  writeVersionPin(data, { version: A, previous: null, at: Date.now() })
})
afterEach(() => {
  for (const [event, original] of listeners) for (const listener of emitter.listeners(event)) {
    if (!original.includes(listener)) emitter.removeListener(event, listener as (...args: unknown[]) => void)
  }
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('supervisor cold-start package selection', () => {
  it('managed cloud starts the first child from its own package, never the stale pinned package', async () => {
    vi.stubEnv('GUGU_CLOUD_COMPUTER', '1')
    await runSupervisor()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(mocks.spawn.mock.calls[0]!.slice(0, 2)).toEqual([process.execPath, [process.argv[1], 'run-account', U]])
    expect(mocks.spawn.mock.calls[0]![2].env.GUGU_CLOUD_COMPUTER).toBe('1')
  })
  it('keeps the host alive and starts the previous pin when the managed package fails account boot admission', async () => {
    vi.stubEnv('GUGU_CLOUD_COMPUTER', '1')
    vi.mocked(checkAccountBoot).mockRejectedValueOnce(new Error('Account backend boot failed'))
    await runSupervisor()
    expect(checkAccountBoot).toHaveBeenCalledWith(path.join(home, 'versions', B, 'bin', 'gugu-server'))
    expect(mocks.spawn.mock.calls[0]!.slice(0, 2)).toEqual([path.join(home, 'versions', A, 'bin', 'gugu-server'), ['run-account', U]])
    expect(readAccountState(path.join(home, 'accounts', U, 'data'))?.version).toBe(A)
    expect(readAccountState(path.join(home, 'accounts', U, 'data'))?.failures[B]?.cause).toBe('boot')
  })
  it.each(['none', 'same', 'missing'] as const)('does not launch a rejected managed package without a usable previous pin (%s)', async fallback => {
    vi.stubEnv('GUGU_CLOUD_COMPUTER', '1')
    const data = path.join(home, 'accounts', U, 'data')
    if (fallback === 'none') fs.rmSync(path.join(data, 'server-version.json'))
    if (fallback === 'same') writeVersionPin(data, { version: B, previous: null, at: Date.now() })
    if (fallback === 'missing') fs.rmSync(path.join(home, 'versions', A, 'bin', 'gugu-server'))
    vi.mocked(checkAccountBoot).mockRejectedValueOnce(new Error('Account backend boot failed'))
    await runSupervisor()
    expect(checkAccountBoot).toHaveBeenCalledWith(path.join(home, 'versions', B, 'bin', 'gugu-server'))
    expect(readAccountState(path.join(home, 'accounts', U, 'data'))?.failures[B]?.cause).toBe('boot')
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(JSON.parse(fs.readFileSync(path.join(data, 'server-update.json'), 'utf8'))).toMatchObject({ state: 'failed', version: B })
    await vi.advanceTimersByTimeAsync(9_000)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
  it('retains failed admission when an account signs in after the managed host started', async () => {
    vi.stubEnv('GUGU_CLOUD_COMPUTER', '1')
    const data = path.join(home, 'accounts', U, 'data')
    fs.rmSync(path.join(data, 'server-session.enc'))
    fs.rmSync(path.join(data, 'server-version.json'))
    vi.mocked(checkAccountBoot).mockRejectedValueOnce(new Error('Account backend boot failed'))
    await runSupervisor()
    fs.writeFileSync(path.join(data, 'server-session.enc'), 'fixture')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(JSON.parse(fs.readFileSync(path.join(data, 'server-update.json'), 'utf8'))).toMatchObject({ state: 'failed', version: B })
  })
  it.each([false, true])('reports rejected boot without claiming an unchanged account rolled back (previous pin=%s)', async keepPin => {
    vi.stubEnv('GUGU_CLOUD_COMPUTER', '1')
    const data = path.join(home, 'accounts', U, 'data')
    if (!keepPin) fs.rmSync(path.join(data, 'server-version.json'))
    const originalPin = keepPin ? A : null
    vi.mocked(checkAccountBoot).mockRejectedValueOnce(new Error('Account backend boot failed'))
    const error = vi.fn()
    const rc = await runMatchVersion(['--account', U, '--apply', B, '--now'], vi.fn(), error, {
      home, runningVersion: () => mocks.spawn.mock.calls.length ? A : null, supervisorRunning: () => true,
      now: () => Date.now(), sleep: async () => { vi.setSystemTime(Date.now() + 1); await runSupervisor() },
    })
    expect(rc).toBe(6)
    expect(readAccountState(path.join(home, 'accounts', U, 'data'))?.failures[B]?.cause).toBe('boot')
    expect(readAccountState(data)?.version).toEqual(originalPin)
    expect(mocks.spawn).toHaveBeenCalledTimes(keepPin ? 1 : 0)
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('启动失败'))
    expect(error).not.toHaveBeenLastCalledWith(expect.stringContaining('已回滚'))
  })
  it('does not reclassify quick-exit backoff or rollback as initial managed package selection', async () => {
    vi.stubEnv('GUGU_CLOUD_COMPUTER', '1')
    await runSupervisor()
    for (const delay of [3_000, 6_000, 9_000]) {
      const child = mocks.spawn.mock.results.at(-1)!.value as EventEmitter
      child.emit('exit', 1, null)
      if (delay < 9_000) await vi.advanceTimersByTimeAsync(delay)
    }
    const data = path.join(home, 'accounts', U, 'data')
    expect(readAccountState(data)?.version).toBe(A)
    expect(readAccountState(path.join(home, 'accounts', U, 'data'))?.failures[B]?.cause).toBe('boot')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(readAccountState(data)?.version).toBe(A)
    expect(mocks.spawn).toHaveBeenCalledTimes(3)
  })
  it('ordinary SSH retains its existing pinned package at cold start, and keeps projecting the pin for an older watchdog', async () => {
    vi.stubEnv('GUGU_CLOUD_COMPUTER', '0')
    await runSupervisor()
    expect(mocks.spawn.mock.calls[0]!.slice(0, 2)).toEqual([path.join(home, 'versions', A, 'bin', 'gugu-server'), ['run-account', U]])
    // The previous supervisor's upgrade watchdog runs old code and reads only this file to exclude the account.
    expect(readVersionPin(path.join(home, 'accounts', U, 'data'))?.version).toBe(A)
  })
})
