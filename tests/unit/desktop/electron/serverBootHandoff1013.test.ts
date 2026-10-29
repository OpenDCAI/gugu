import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { spawnOwnedChild } from '@gugu/session-core/exec'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServerVersionLifecycle, pointCurrent } from '../../../../apps/desktop/electron/server/server-version-lifecycle'
import { ACCOUNT_BOOT_READY_TIMEOUT_MS, createAccountVersionConverger } from '../../../../apps/desktop/electron/server/server-account-converge'
import { accountDataDir } from '../../../../apps/desktop/electron/server/server-layout'
import { recordDesktopReport } from '../../../../packages/core/src/cloud/serverDesktopVersions'
import { runMatchVersion } from '../../../../apps/desktop/electron/server/match-version-cli'
import { readAccountVersionPin } from '../../../../apps/desktop/electron/server/server-account-versions'
import { readBadVersions } from '../../../../apps/desktop/electron/server/server-upgrade-guard'

let home: string | undefined
const savedEnv = { ...process.env }
afterEach(() => {
  process.env = { ...savedEnv }
  if (home) { fs.rmSync(home, { recursive: true, force: true }); home = undefined }
})

function binary(version: string, body: string) {
  const bin = path.join(home!, 'versions', version, 'bin', 'gugu-server')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, `#!${process.execPath}\n${body}`, { mode: 0o700 })
  return bin
}

function realSignalExit() {
  const file = ts.createSourceFile('main.ts', fs.readFileSync(path.resolve(__dirname, '../../../../apps/desktop/electron/main.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const owner = file.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(decl => decl.name.getText(file) === 'exitOnSignal'))!
  const signal = file.statements.find(node => ts.isExpressionStatement(node) && node.getText(file).startsWith("process.on('SIGTERM'"))!
  return ts.transpileModule(`const app={getPath:()=>''}, noteExitReason=()=>{}, killEnginesOnCrash=()=>{}, deviceRuntimeHost=null, SERVER_MODE=true; let signalStopping=false; ${owner.getText(file)}; ${signal.getText(file)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}

describe.runIf(process.platform !== 'win32')('supervisor boot admission and rollback use real owned processes', () => {
  it('rejects a cached package that cannot boot, then retries the same stage and releases the entire scratch boot process', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-handoff-'))
    process.env.GUGU_SERVER_HOME = home
    const previous = '0.2.58-beta.100.1'
    const target = '0.2.58-beta.101.1'
    binary(previous, 'process.exit(0)')
    const readings = path.join(home, 'boot-processes.jsonl')
    const record = `require('node:fs').appendFileSync(${JSON.stringify(readings)}, JSON.stringify({pid:process.pid, home:process.env.GUGU_SERVER_HOME, args:process.argv.slice(2)})+'\\n');`
    binary(target, `${record}process.exit(1)`)
    pointCurrent(home, path.join(home, 'versions', previous))
    const lifecycle = createServerVersionLifecycle({ layout: { home, versions: path.join(home, 'versions'), version: previous } })
    const staged = vi.fn(async () => {}) // Cached directory already exists; no download is needed.
    await expect(lifecycle.stage(target, staged)).rejects.toThrow('Account boot exited before serving')
    expect(lifecycle.ready(target)).toBe(false)
    expect(() => lifecycle.switchAccount(path.join(home!, 'account-data'), target, previous, 1)).toThrow('boot verification')
    expect(() => lifecycle.switchSupervisor({ from: previous, to: target,
      fromDir: path.join(home!, 'versions', previous), toDir: path.join(home!, 'versions', target), switchedAt: 1 }, () => {})).toThrow('boot verification')
    expect(fs.readlinkSync(path.join(home, 'current'))).toBe(`versions/${previous}`)
    binary(target, `${record}${realSignalExit()}const d=process.env.GUGU_TASK_HOST_USER_DATA;require('node:fs').mkdirSync(d,{recursive:true});require('node:fs').writeFileSync(require('node:path').join(d,'activity.json'),JSON.stringify({pid:process.pid,startedAt:Date.now(),at:Date.now(),busy:false,runtimeOwned:true}));setInterval(()=>{},1000)`)
    await lifecycle.stage(target, staged)
    expect(lifecycle.ready(target)).toBe(true)
    expect(lifecycle.runtimeOwned(target)).toBe(true)
    const rows = fs.readFileSync(readings, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { pid: number; home: string; args: string[] })
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.home).not.toBe(home)
      expect(row.args[0]).toBe('run-account')
      expect(() => process.kill(row.pid, 0)).toThrow()
      expect(fs.existsSync(row.home)).toBe(false)
    }
    // Concurrent account/supervisor callers reuse the completed stage instead of starting another probe.
    await lifecycle.stage(target, staged)
    expect(staged).toHaveBeenCalledTimes(2)
  })

  it('keeps the previous account pin when a real target exits during account-specific boot after passing cold boot', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-rollback-'))
    process.env.GUGU_SERVER_HOME = home
    const userId = '00000000-0000-4000-8000-000000000001'
    const previous = '0.2.58-beta.100.1'
    const target = '0.2.58-beta.101.1'
    binary(previous, 'process.exit(0)')
    const candidate = binary(target, `if(process.argv[3]===${JSON.stringify(userId)})process.exit(1);const d=process.env.GUGU_TASK_HOST_USER_DATA;require('node:fs').mkdirSync(d,{recursive:true});require('node:fs').writeFileSync(require('node:path').join(d,'activity.json'),JSON.stringify({pid:process.pid,startedAt:Date.now(),at:Date.now(),busy:false,runtimeOwned:true}));setInterval(()=>{},1000)`)
    pointCurrent(home, path.join(home, 'versions', previous))
    const lifecycle = createServerVersionLifecycle({ layout: { home, versions: path.join(home, 'versions'), version: previous } })
    await lifecycle.stage(target, async () => {})
    const dataDir = accountDataDir(userId)
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'activity.json'), JSON.stringify({ runtimeOwned: true, busy: false, pid: process.pid, startedAt: 10, at: 20 }))
    recordDesktopReport(dataDir, { id: 'fixture-desktop', version: target, protocol: null }, 20)
    const restart = vi.fn()
    const converge = createAccountVersionConverger({
      layout: { home, versions: path.join(home, 'versions'), version: previous }, lifecycle,
      log: { info: vi.fn(), warn: vi.fn() }, running: () => previous, restart,
      runningProcess: () => ({ pid: process.pid, startedAt: 10 }), now: () => 20,
    })
    converge.converge([{ userId, dataDir, dir: path.dirname(dataDir), homeDir: path.join(path.dirname(dataDir), 'home'), signedIn: true, signedOut: null, email: null, addedAt: null }])
    expect(restart).toHaveBeenCalledOnce()
    expect(readAccountVersionPin(dataDir)?.version).toBe(target)
    for (let attempt = 0; attempt < 3; attempt++) {
      const exit = Promise.withResolvers<number | null>()
      const owned = spawnOwnedChild(candidate, ['run-account', userId], { stdio: 'ignore', onError: error => exit.reject(error) })
      owned.child.once('exit', code => exit.resolve(code))
      try { expect(await exit.promise).toBe(1) } finally { await owned.stop() }
      converge.quickExit(userId, target)
    }
    expect(readAccountVersionPin(dataDir)?.version).toBe(previous)
    expect(readBadVersions(home)[target]).toBe(20)
    expect(fs.readlinkSync(path.join(home, 'current'))).toBe(`versions/${previous}`)
  })

  it('rolls back a switched account that stays alive without its own ready heartbeat, while legacy migration requires explicit confirmation', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-no-heartbeat-'))
    process.env.GUGU_SERVER_HOME = home
    const userId = '00000000-0000-4000-8000-000000000002'
    const previous = '0.2.58-beta.100.1', target = '0.2.58-beta.101.1'
    binary(previous, 'process.exit(0)')
    const candidate = binary(target, 'setInterval(()=>{},1000)')
    pointCurrent(home, path.join(home, 'versions', previous))
    // This test targets account-specific readiness after an independently staged cold boot.
    const lifecycle = createServerVersionLifecycle({ layout: { home, versions: path.join(home, 'versions'), version: previous }, verifyBoot: async () => {} })
    await lifecycle.stage(target, async () => {})
    const dataDir = accountDataDir(userId)
    fs.mkdirSync(dataDir, { recursive: true })
    let clock = 1_000, current = previous
    fs.writeFileSync(path.join(dataDir, 'activity.json'), JSON.stringify({ busy: false, at: clock, pid: process.pid, startedAt: 1 }))
    recordDesktopReport(dataDir, { id: 'fixture-desktop', version: target, protocol: null }, clock)
    const restart = vi.fn(), state = { set: vi.fn(), clear: vi.fn() }
    let child: { pid: number | undefined; startedAt: number } = { pid: process.pid, startedAt: 1 }
    const account = { userId, dataDir, dir: path.dirname(dataDir), homeDir: path.join(path.dirname(dataDir), 'home'), signedIn: true, signedOut: null, email: null, addedAt: null }
    const converge = createAccountVersionConverger({ layout: { home, versions: path.join(home, 'versions'), version: previous }, lifecycle,
      log: { info: vi.fn(), warn: vi.fn() }, running: () => current, runningProcess: () => child, restart,
      stateWriter: () => state, now: () => clock })
    converge.converge([account])
    expect(restart).not.toHaveBeenCalled()
    expect(state.set).toHaveBeenLastCalledWith('ready', target, 'runtime-unverified')
    const error = vi.fn()
    const cli = { home, accounts: () => [account], supervisorRunning: () => true, runningVersion: () => current,
      now: () => clock, readUpdateState: () => JSON.stringify({ state: 'ready', version: target, at: clock, reason: 'runtime-unverified' }) }
    expect(await runMatchVersion(['--account', userId, '--apply', target], vi.fn(), error, cli)).toBe(8)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--now'))
    expect(restart).not.toHaveBeenCalled()
    expect(await runMatchVersion(['--account', userId, '--apply', target, '--now'], vi.fn(), error, {
      ...cli, sleep: async () => { converge.converge([account]); current = target },
    })).toBe(0)
    expect(restart).toHaveBeenCalledOnce()
    const owned = spawnOwnedChild(candidate, ['run-account', userId], { stdio: 'ignore', onError: error => { throw error } })
    try {
      current = target
      child = { pid: owned.child.pid, startedAt: clock }
      expect(() => process.kill(owned.child.pid!, 0)).not.toThrow()
      clock += ACCOUNT_BOOT_READY_TIMEOUT_MS
      converge.converge([account])
      expect(restart).toHaveBeenCalledTimes(2)
      expect(readAccountVersionPin(dataDir)?.version).toBe(previous)
      expect(readBadVersions(home)[target]).toBe(clock)
      expect(state.set).toHaveBeenLastCalledWith('failed', target, undefined)
    } finally { await owned.stop() }
  })

  it('rejects a legacy package without PID readiness before changing any live pin', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-legacy-readiness-'))
    process.env.GUGU_SERVER_HOME = home
    const version = '0.2.58-beta.99.1'
    binary(version, `${realSignalExit()}const fs=require('node:fs'),p=require('node:path'),d=process.env.GUGU_TASK_HOST_USER_DATA;fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'activity.json'),JSON.stringify({at:Date.now(),busy:false}));setInterval(()=>{},1000)`)
    const lifecycle = createServerVersionLifecycle({ layout: { home, versions: path.join(home, 'versions'), version } })
    await expect(lifecycle.stage(version, async () => {})).rejects.toThrow('PID-bound boot readiness')
    expect(lifecycle.ready(version)).toBe(false)
    expect(() => lifecycle.switchAccount(path.join(home!, 'account'), version, null, 1)).toThrow('boot verification')
  })

  it('explicitly migrates an old account despite old desktop affinity, fences automatic return, and still permits a PID-proven confirmed downgrade', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-legacy-migration-'))
    process.env.GUGU_SERVER_HOME = home
    const previous = '0.2.58-beta.100.1', target = '0.2.58-beta.101.1'
    for (const [version, modern] of [[previous, false], [target, true]] as const) {
      binary(version, `${realSignalExit()}const fs=require('node:fs'),p=require('node:path'),d=process.env.GUGU_TASK_HOST_USER_DATA;fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'activity.json'),JSON.stringify({pid:process.pid,startedAt:Date.now(),at:Date.now(),busy:false,...${modern ? '{runtimeOwned:true}' : '{}'}}));setInterval(()=>{},1000)`)
    }
    const lifecycle = createServerVersionLifecycle({ layout: { home, versions: path.join(home, 'versions'), version: target } })
    await lifecycle.stage(previous, async () => {})
    await lifecycle.stage(target, async () => {})
    expect(lifecycle.runtimeOwned(previous)).toBe(false)
    expect(lifecycle.runtimeOwned(target)).toBe(true)
    const userId = '00000000-0000-4000-8000-000000000003', dataDir = accountDataDir(userId)
    fs.mkdirSync(dataDir, { recursive: true })
    const clock = Date.now()
    const publish = (modern: boolean) => fs.writeFileSync(path.join(dataDir, 'activity.json'), JSON.stringify({ pid: process.pid, startedAt: 1, at: clock, busy: false, ...(modern ? { runtimeOwned: true } : {}) }))
    publish(false)
    recordDesktopReport(dataDir, { id: 'old-desktop', version: previous, protocol: null }, clock)
    const account = { userId, dataDir, dir: path.dirname(dataDir), homeDir: path.join(path.dirname(dataDir), 'home'), signedIn: true, signedOut: null, email: null, addedAt: null }
    let current = previous
    const restart = vi.fn(), state = { set: vi.fn(), clear: vi.fn() }
    const converge = createAccountVersionConverger({ layout: { home, versions: path.join(home, 'versions'), version: target }, lifecycle,
      log: { info: vi.fn(), warn: vi.fn() }, running: () => current, runningProcess: () => ({ pid: process.pid, startedAt: 1 }), restart,
      stateWriter: () => state, now: () => clock })
    const apply = async (version: string) => runMatchVersion(['--account', userId, '--apply', version, '--now'], vi.fn(), vi.fn(), {
      home: home!, accounts: () => [account], supervisorRunning: () => true, runningVersion: () => current, now: () => clock,
      sleep: async () => { converge.converge([account]); current = readAccountVersionPin(dataDir)?.version ?? current },
    })
    expect(await apply(target)).toBe(0)
    expect(restart).toHaveBeenCalledOnce()
    publish(true)
    converge.converge([account])
    expect(restart).toHaveBeenCalledOnce()
    expect(state.set).toHaveBeenLastCalledWith('ready', previous, 'runtime-unverified')
    expect(await apply(previous)).toBe(0)
    expect(restart).toHaveBeenCalledTimes(2)
    expect(readAccountVersionPin(dataDir)?.version).toBe(previous)
  })

})
