import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordDesktopReport, requestConfirmedVersionRestart, requestVersionRetry, requestVersionSwitch } from '../../../../packages/core/src/cloud/serverDesktopVersions'
import { REMOTE_PROTOCOL_VERSION } from '../../../../packages/core/src/cloud/serverMachineHealth'
import { createAccountVersionConverger, VERSION_FAILURE_COOLDOWN_MS } from '../../../../apps/desktop/electron/server/server-account-converge'
import { readAccountVersionPin, writeAccountVersionPin } from '../../../../apps/desktop/electron/server/server-account-versions'
import { createServerVersionLifecycle, type ServerVersionLifecycle } from '../../../../apps/desktop/electron/server/server-version-lifecycle'
import { runMatchVersion } from '../../../../apps/desktop/electron/server/match-version-cli'
import { createServerUpdateStateWriter, type ServerUpdateStateWriter } from '../../../../apps/desktop/electron/server/server-updater'
import { listAccounts, type ServerAccount } from '../../../../apps/desktop/electron/server/server-layout'
import { judgeUpgrade, readBadVersions, readProbe, STABLE_MS, writeSupervisorHealth } from '../../../../apps/desktop/electron/server/server-upgrade-guard'

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const A = '0.2.58-fc-staging.aaaaaaaa'
const B = '0.2.58-fc-staging.bbbbbbbb'
const NOW = 1_800_000_000_000
let home: string
let clock: number
let lifecycle: ServerVersionLifecycle
beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cloud-package-1003-'))
  vi.stubEnv('GUGU_SERVER_HOME', home)
  clock = NOW
  install(A)
  install(B)
  signIn(U1)
  lifecycle = createServerVersionLifecycle({ layout: { home, versions: path.join(home, 'versions'), version: B },
    verifyBoot: async () => ({ runtimeOwned: true }) })
  await lifecycle.stage(A, async () => {})
  await lifecycle.stage(B, async () => {})
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
function report(version: string, id = U1) {
  recordDesktopReport(data(id), { id: 'desktop', version, protocol: REMOTE_PROTOCOL_VERSION }, clock)
}
function pin(version: string, id = U1) {
  writeAccountVersionPin(data(id), { version, previous: null, at: clock })
}
function fixture(supervisor: string, initial: string | undefined, managed = true) {
  const running = new Map<string, string>()
  if (initial) running.set(U1, initial)
  const restarted: string[] = []
  const staged: string[] = []
  let busy = false
  const states: string[][] = []
  const warn = vi.fn()
  const options = {
    layout: { home, versions: path.join(home, 'versions'), version: supervisor },
    followSupervisor: managed,
    coldStart: () => initial === undefined,
    lifecycle,
    log: { info: () => undefined, warn },
    stateWriter: (account: ServerAccount): ServerUpdateStateWriter => {
      const writer = createServerUpdateStateWriter(account.dir, () => clock)
      return { set(state, version, reason) { states.push([state, version]); writer.set(state, version, reason) }, clear: writer.clear }
    },
    running: (id: string) => running.get(id),
    restart: (id: string) => void restarted.push(id),
    now: () => clock,
    busy: () => busy,
    stage: async (version: string) => { staged.push(version) },
  }
  const c = createAccountVersionConverger(options)
  return { c, running, restarted, staged, states, warn, busy: (value: boolean) => { busy = value }, converge: () => c.converge(listAccounts().filter((a) => a.signedIn)) }
}

describe('managed cloud accounts follow the running supervisor package', () => {
  it('switches equal-semver hash packages despite an earlier desktop report', () => {
    report(A)
    pin(A)
    const f = fixture(B, A)
    f.converge()
    expect(readAccountVersionPin(data())?.version).toBe(B)
    expect(f.restarted).toEqual([U1])
    expect(f.staged).toEqual([])
  })
  it('follows an explicit downgrade even when the desktop reports a higher version', () => {
    const newer = '0.3.0'
    install(newer)
    report(newer)
    pin(newer)
    const f = fixture(A, newer)
    f.converge()
    expect(readAccountVersionPin(data())).toMatchObject({ version: A, previous: newer })
    expect(f.restarted).toEqual([U1])
  })
  it('reconciles a stale pin with no desktop reports before a cold start', () => {
    pin(A)
    const f = fixture(B, undefined)
    f.converge()
    expect(readAccountVersionPin(data())?.version).toBe(B)
    expect(f.c.binaryFor(U1)).toBeNull()
    expect(f.restarted).toEqual([])
  })
  it('does not let a desktop-confirmed request interrupt a busy managed account', () => {
    report(A)
    pin(A)
    requestVersionRetry({ GUGU_SERVER_MODE: '1', GUGU_TASK_HOST_USER_DATA: data() }, clock)
    const f = fixture(B, A)
    f.busy(true)
    f.converge()
    expect(f.restarted).toEqual([])
    expect(readAccountVersionPin(data())?.version).toBe(A)
    f.busy(false)
    f.converge()
    expect(f.restarted).toEqual([U1])
    expect(readAccountVersionPin(data())?.version).toBe(B)
  })
  it('rejects a confirmed desktop target outside the managed controller package without interrupting work', () => {
    pin(B)
    const f = fixture(B, B)
    f.busy(true)
    expect(requestConfirmedVersionRestart({ GUGU_SERVER_MODE: '1', GUGU_TASK_HOST_USER_DATA: data() }, A, true, clock)).toBe(true)
    f.converge()
    expect(readAccountVersionPin(data())?.version).toBe(B)
    expect(f.restarted).toEqual([])
    expect(f.staged).toEqual([])
    expect(f.states).toContainEqual(['failed', A])
  })
  it('reports a rejected managed target to apply instead of waiting for its timeout', async () => {
    pin(B)
    const f = fixture(B, B)
    f.busy(true)
    const error = vi.fn()
    for (let attempt = 0; attempt < 2; attempt++) {
      clock += 1
      const rc = await runMatchVersion(['--account', U1, '--apply', A, '--now'], vi.fn(), error, {
        home, runningVersion: () => B, supervisorRunning: () => true, now: () => clock,
        sleep: async () => { clock += 500; f.converge() },
      })
      expect(rc).toBe(6)
    }
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining(A))
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining(B))
    expect(f.restarted).toEqual([])
  })
  it('restarts only the mismatched account and does not repeatedly kill its draining process', () => {
    signIn(U2)
    report(A)
    report(B, U2)
    pin(A)
    const f = fixture(B, A)
    f.running.set(U2, B)
    f.converge()
    f.converge()
    expect(f.restarted).toEqual([U1])
    expect(f.running.get(U2)).toBe(B)
  })
  it('retains rollback and persisted failure cooldown across supervisor restarts', () => {
    pin(A)
    const f = fixture(B, undefined)
    f.converge()
    for (let i = 0; i < 3; i += 1) f.c.quickExit(U1, B)
    expect(readAccountVersionPin(data())?.version).toBe(A)
    expect(readBadVersions(home)[B]).toBe(clock)
    const restartedSupervisor = fixture(B, undefined)
    restartedSupervisor.converge()
    expect(restartedSupervisor.c.binaryFor(U1)?.version).toBe(A)
    expect(restartedSupervisor.restarted).toEqual([])
    clock += VERSION_FAILURE_COOLDOWN_MS + 1
    restartedSupervisor.converge()
    expect(restartedSupervisor.c.binaryFor(U1)).toBeNull()
  })
  it('desktop protocol reports and ordinary Retry do not authorise a managed failure override; target-bound confirmation can', () => {
    pin(A)
    const f = fixture(B, undefined)
    f.converge()
    for (let i = 0; i < 3; i += 1) f.c.quickExit(U1, B)
    clock += 1_000
    requestVersionSwitch(data(), 'desktop protocol mismatch', clock)
    const next = fixture(B, undefined)
    next.converge()
    expect(next.c.binaryFor(U1)?.version).toBe(A)
    clock += 1_000
    requestVersionRetry({ GUGU_SERVER_MODE: '1', GUGU_TASK_HOST_USER_DATA: data() }, clock)
    next.converge()
    expect(next.c.binaryFor(U1)?.version).toBe(A)
    clock += 1_000
    requestConfirmedVersionRestart({ GUGU_SERVER_MODE: '1', GUGU_TASK_HOST_USER_DATA: data() }, B, true, clock)
    next.converge()
    expect(next.c.binaryFor(U1)).toBeNull()
  })
  it('never downloads a missing supervisor package and reports a throttled failure until it is restored', async () => {
    pin(A)
    fs.rmSync(path.join(home, 'versions', B, 'bin', 'gugu-server'))
    const f = fixture(B, A)
    for (let i = 0; i < 20; i += 1) {
      f.converge()
      await Promise.resolve()
      clock += 3_000
    }
    expect(f.staged).toEqual([])
    expect(f.states).toContainEqual(['failed', B])
    expect(f.warn).toHaveBeenCalledTimes(1)
    expect(f.restarted).toEqual([])
    f.converge()
    expect(f.warn).toHaveBeenCalledTimes(2)
    install(B)
    f.converge()
    expect(f.restarted).toEqual([U1])
  })
  it('ordinary SSH accounts still follow desktop reports instead of the supervisor', () => {
    report(A)
    const f = fixture(B, B, false)
    f.converge()
    expect(readAccountVersionPin(data())?.version).toBe(A)
    expect(f.restarted).toEqual([U1])
  })
  it('ordinary SSH accounts without reports retain their existing pin', () => {
    pin(A)
    const f = fixture(B, undefined, false)
    f.converge()
    expect(f.c.binaryFor(U1)?.version).toBe(A)
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
