import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeAccountVersionPin } from '../../../../apps/desktop/electron/server/server-account-versions'
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
  mocks.spawn.mockReset().mockImplementation(() => Object.assign(new EventEmitter(), { pid: 999, exitCode: null, signalCode: null, kill: vi.fn() }))
  for (const version of [A, B]) {
    const bin = path.join(home, 'versions', version, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'gugu-server'), '#!/bin/sh\n')
  }
  const data = path.join(home, 'accounts', U, 'data')
  fs.mkdirSync(data, { recursive: true })
  fs.writeFileSync(path.join(data, 'server-session.enc'), 'x')
  writeAccountVersionPin(data, { version: A, previous: null, at: Date.now() })
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
  it('ordinary SSH retains its existing pinned package at cold start', async () => {
    vi.stubEnv('GUGU_CLOUD_COMPUTER', '0')
    await runSupervisor()
    expect(mocks.spawn.mock.calls[0]!.slice(0, 2)).toEqual([path.join(home, 'versions', A, 'bin', 'gugu-server'), ['run-account', U]])
  })
})
