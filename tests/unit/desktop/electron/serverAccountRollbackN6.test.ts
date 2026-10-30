import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnOwnedChild } from '@gugu/session-core/exec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccountVersionConverger } from '../../../../apps/desktop/electron/server/server-account-converge'
import { readAccountVersionPin, writeAccountVersionPin } from '../../../../apps/desktop/electron/server/server-account-versions'
import { accountDataDir, listAccounts } from '../../../../apps/desktop/electron/server/server-layout'
import { runMatchVersion } from '../../../../apps/desktop/electron/server/match-version-cli'
import { createServerVersionLifecycle, pointCurrent, recordVerifiedSupervisorVersion } from '../../../../apps/desktop/electron/server/server-version-lifecycle'
import { addBadVersion, readBadVersions } from '../../../../apps/desktop/electron/server/server-upgrade-guard'
import { readVersionSwitchRequest, recordDesktopReport, requestVersionSwitch, VERSION_SWITCH_FILE } from '../../../../packages/core/src/cloud/serverDesktopVersions'

let home: string
const savedHome = process.env.GUGU_SERVER_HOME
const userId = '00000000-0000-4000-8000-000000000006'
const previous = '0.2.58-beta.100.1'
const target = '0.2.58-beta.103.1'
const affinity = '0.2.58-beta.104.1'
const data = () => accountDataDir(userId)
const layout = () => ({ home, versions: path.join(home, 'versions'), version: affinity })

function binary(version: string, body = 'process.exit(0)') {
  const file = path.join(home, 'versions', version, 'bin', 'gugu-server')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o700 })
  return file
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-n6-')))
  process.env.GUGU_SERVER_HOME = home
  fs.mkdirSync(data(), { recursive: true })
  fs.writeFileSync(path.join(data(), 'server-session.enc'), 'fixture')
  binary(previous)
  binary(affinity)
  pointCurrent(home, path.join(home, 'versions', affinity))
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.GUGU_SERVER_HOME
  else process.env.GUGU_SERVER_HOME = savedHome
  fs.rmSync(home, { recursive: true, force: true })
})

describe.runIf(process.platform !== 'win32')('account rollback across supervisor backoff', () => {
  it('keeps the explicit trial through real quick exits, rolls directly back to the legacy binary, and tells apply without timing out', async () => {
    const candidate = binary(target, `if(process.argv[3]===${JSON.stringify(userId)})process.exit(1);const fs=require('node:fs'),p=require('node:path'),d=process.env.GUGU_TASK_HOST_USER_DATA;fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'activity.json'),JSON.stringify({pid:process.pid,startedAt:Date.now(),at:Date.now(),busy:false,runtimeOwned:true}));setInterval(()=>{},1000)`)
    // The previous package deliberately has no PID readiness. Rollback must not stage or validate it.
    const previousBytes = fs.readFileSync(binary(previous))
    const lifecycle = createServerVersionLifecycle({ layout: layout() })
    await lifecycle.stage(target, async () => {})
    // Verify the competing desktop package too, so readiness cannot incidentally mask the takeover.
    binary(affinity, fs.readFileSync(candidate, 'utf8').split('\n').slice(1).join('\n'))
    await lifecycle.stage(affinity, async () => {})
    let clock = 1_000
    recordDesktopReport(data(), { id: 'old-desktop', version: previous, protocol: null }, clock)
    recordDesktopReport(data(), { id: 'new-desktop', version: affinity, protocol: null }, clock)
    writeAccountVersionPin(data(), { version: previous, previous: null, at: 1 })
    let current: string | undefined = previous
    const stage = vi.fn(async () => { throw new Error('Rollback must use the installed previous package') })
    const converger = createAccountVersionConverger({ layout: layout(), lifecycle, now: () => clock,
      running: () => current, runningProcess: () => current ? { pid: process.pid, startedAt: 1 } : undefined,
      log: { info: vi.fn(), warn: vi.fn() }, restart: vi.fn(), stage })
    const accounts = listAccounts()
    let attempts = 0
    const error = vi.fn()
    const rc = await runMatchVersion(['--account', userId, '--apply', target, '--now'], vi.fn(), error, {
      home, runningVersion: () => current ?? null, supervisorRunning: () => true, now: () => clock,
      waitMs: 50_000,
      sleep: async () => {
        if (current === previous) {
          converger.converge(accounts)
          expect(readAccountVersionPin(data())).toMatchObject({ version: target, previous })
          expect(readVersionSwitchRequest(data(), clock)).toBeNull()
          current = undefined // Old child exited; supervisor is in its restart backoff.
          return
        }
        const exit = Promise.withResolvers<number | null>()
        const owned = spawnOwnedChild(candidate, ['run-account', userId], { stdio: 'ignore', onError: error => exit.reject(error) })
        owned.child.once('exit', code => exit.resolve(code))
        try { expect(await exit.promise).toBe(1) } finally { await owned.stop() }
        clock += 4_000
        converger.quickExit(userId, target)
        attempts++
        // Real reconcile also runs BETWEEN exits, while the account has no child.
        converger.converge(accounts)
        converger.converge(accounts)
        expect(readAccountVersionPin(data())?.version).toBe(attempts < 3 ? target : previous)
      },
    })
    expect(attempts).toBe(3)
    expect(rc).toBe(6)
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining(previous))
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('回滚'))
    expect(readBadVersions(home)[target]).toBe(clock)
    expect(converger.binaryFor(userId)?.version).toBe(previous)
    expect(fs.readFileSync(path.join(home, 'versions', previous, 'bin', 'gugu-server'))).toEqual(previousBytes)
    expect(stage).not.toHaveBeenCalled()
    expect(fs.readlinkSync(path.join(home, 'current'))).toBe(`versions/${affinity}`)
  })

  it('keeps every stored desktop reference, including lower versions, until that report is removed', () => {
    binary(target)
    const spare = '0.2.58-beta.102.1'
    binary(spare)
    recordVerifiedSupervisorVersion(home, { from: target, to: affinity, fromDir: path.join(home, 'versions', target), toDir: path.join(home, 'versions', affinity), switchedAt: 1 })
    recordDesktopReport(data(), { id: 'old-desktop', version: previous, protocol: null })
    recordDesktopReport(data(), { id: 'new-desktop', version: affinity, protocol: null })
    const lifecycle = createServerVersionLifecycle({ layout: layout() })
    expect(lifecycle.reclaim()).toEqual([spare])
    expect(fs.existsSync(path.join(home, 'versions', previous))).toBe(true)
    // The canonical report writer owns expiry/removal; reclaim does not invent a second selection rule.
    fs.writeFileSync(path.join(data(), 'desktop-versions.json'), '{}')
    expect(lifecycle.reclaim()).toEqual([previous])
  })

  it.each(['pin', 'request', 'rollback'] as const)('reports a superseding %s immediately, while ignoring a pre-existing different pin', async mode => {
    let clock = 1_000
    writeAccountVersionPin(data(), { version: previous, previous: null, at: 1 })
    const error = vi.fn()
    const sleep = vi.fn(async () => {
      clock++
      if (mode === 'pin') {
        fs.rmSync(path.join(data(), VERSION_SWITCH_FILE), { force: true })
        writeAccountVersionPin(data(), { version: affinity, previous: target, at: clock })
      } else if (mode === 'request') requestVersionSwitch(data(), 'another confirmed command', clock, true, affinity)
      else {
        createServerVersionLifecycle({ layout: layout() }).rollbackAccount(data(), null, clock)
        addBadVersion(home, target, clock)
      }
    })
    const rc = await runMatchVersion(['--account', userId, '--apply', target, '--now'], vi.fn(), error, {
      home, accounts: listAccounts, runningVersion: () => previous, supervisorRunning: () => true,
      now: () => clock, sleep, waitMs: 10,
    })
    expect(sleep).toHaveBeenCalledOnce()
    expect(rc).toBe(6)
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining(target))
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining(mode === 'rollback' ? '守护进程版本' : affinity))
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining(previous))
  })
})
