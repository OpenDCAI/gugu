import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readVersionSwitchRequest } from '../../../../packages/core/src/cloud/serverDesktopVersions'
import { writeVersionPin } from '../../../../apps/desktop/electron/server/server-account-versions'
import { runMatchVersion } from '../../../../apps/desktop/electron/server/match-version-cli'
import { judgeUpgrade, readProbe, STABLE_MS, writeSupervisorHealth } from '../../../../apps/desktop/electron/server/server-upgrade-guard'

const U1 = '11111111-1111-4111-8111-111111111111'
const A = '0.2.58-fc-staging.aaaaaaaa'
const B = '0.2.58-fc-staging.bbbbbbbb'
const NOW = 1_800_000_000_000
let home: string
let clock: number
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cloud-package-1003-'))
  vi.stubEnv('GUGU_SERVER_HOME', home)
  clock = NOW
  install(A)
  install(B)
  signIn(U1)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})
const data = (id = U1) => path.join(home, 'accounts', id, 'data')
function signIn(id: string) {
  fs.mkdirSync(data(id), { recursive: true })
  fs.writeFileSync(path.join(data(id), 'server-session.enc'), 'x')
}
function install(version: string) {
  const bin = path.join(home, 'versions', version, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'gugu-server'), '#!/bin/sh\n')
}
function pin(version: string, id = U1) {
  writeVersionPin(data(id), { version, previous: null, at: clock })
}

describe('managed cloud accounts follow the running supervisor package', () => {
  it('refuses a managed target outside the supervisor package at once, without leaving a request to wait on', async () => {
    pin(B)
    const error = vi.fn()
    const sleep = vi.fn(async () => {})
    const rc = await runMatchVersion(['--account', U1, '--apply', A, '--now'], vi.fn(), error, {
      home, runningVersion: () => B, supervisorRunning: () => true, managedSupervisorVersion: () => B, now: () => clock, sleep,
    })
    expect(rc).toBe(6)
    expect(sleep).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`守护进程的包 ${B}`))
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`不能换到 ${A}`))
    expect(readVersionSwitchRequest(data(), clock)).toBeNull()
  })
})

function supervisorCloudEnvironment(enabled: boolean) {
  fs.mkdirSync(path.join(home, 'data'), { recursive: true })
  fs.writeFileSync(path.join(home, 'data', 'server.lock'), String(process.pid))
  const original = fs.readFileSync.bind(fs)
  vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const file = String(args[0])
    if (file === `/proc/${process.pid}/environ`) return enabled ? 'GUGU_CLOUD_COMPUTER=1\0' : 'GUGU_CLOUD_COMPUTER=0\0'
    if (file === `/proc/${process.pid}/cmdline`) return 'node server.js run\0'
    return original(...args)
  }) as typeof fs.readFileSync)
}

describe('managed cloud readiness uses actual account heartbeats', () => {
  it('does not exclude a wrongly pinned account and declare only the supervisor healthy', () => {
    vi.stubEnv('GUGU_CLOUD_COMPUTER', '')
    supervisorCloudEnvironment(true)
    pin(A)
    const now = NOW + STABLE_MS + 30_000
    const heartbeat = { version: A, startedAt: NOW - 3_600_000, at: now - 1_000 }
    fs.writeFileSync(path.join(data(), 'activity.json'), JSON.stringify(heartbeat))
    writeSupervisorHealth(home, { version: B, pid: 1, startedAt: NOW + 5_000 }, now - 1_000)
    const marker = { from: A, to: B, fromDir: path.join(home, 'versions', A), toDir: path.join(home, 'versions', B), switchedAt: NOW }
    const probe = readProbe(home, marker, NOW, now)
    expect(probe.accounts).toEqual([heartbeat])
    expect(judgeUpgrade(probe)).toBe('waiting')
  })
  it('does not turn an ordinary SSH supervisor into managed mode because the guard inherited that flag', () => {
    vi.stubEnv('GUGU_CLOUD_COMPUTER', '1')
    supervisorCloudEnvironment(false)
    pin(A)
    const now = NOW + STABLE_MS + 30_000
    fs.writeFileSync(path.join(data(), 'activity.json'), JSON.stringify({ version: A, startedAt: NOW, at: now }))
    writeSupervisorHealth(home, { version: B, pid: process.pid, startedAt: NOW }, now)
    const marker = { from: A, to: B, fromDir: path.join(home, 'versions', A), toDir: path.join(home, 'versions', B), switchedAt: NOW }
    expect(readProbe(home, marker, NOW, now).accounts).toEqual([])
  })

})
