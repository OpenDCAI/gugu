import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServerVersionLifecycle, pointCurrent } from '../../../../apps/desktop/electron/server/server-version-lifecycle'

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

// The real signal exit (signal-exit.ts, the handlers main registers), transpiled as it is into the child binary's
// script, with main's server-mode wiring and no device runtime host.
function realSignalExit() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../../../apps/desktop/electron/signal-exit.ts'), 'utf8')
  const module = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  return `{const exports={};${module};exports.createSignalExit({serverMode:true,exitRestart:75,exitSignedOut:78,stopActivity(){},singleRun:()=>false,sessionFileExists:()=>true,supervisedBy:()=>undefined,markStopped(){},noteExitReason(){},killEngines(){},exit:(code)=>process.exit(code),host:()=>null,stopHost:async()=>{},warn(){}}).listen((signal,handler)=>{process.on(signal,handler)})}`
}

describe.runIf(process.platform !== 'win32')('real-binary boot smoke: a package is admitted only after a real account process serves', () => {
  it('routes the legacy guard SIGUSR2 through the real graceful exit handler with code 75', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-guard-signal-'))
    const command = binary('1.0.0', `${realSignalExit()}process.stdin.resume();process.stdout.write('ready')`)
    const child = spawn(command, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      expect(String((await once(child.stdout!, 'data'))[0])).toBe('ready')
      const closed = once(child, 'close')
      child.kill('SIGUSR2')
      expect(await closed).toEqual([75, null])
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close'); child.kill('SIGTERM'); await closed
      }
    }
  })
  it('rejects a cached package that cannot boot, then retries the same stage and releases the entire scratch boot process', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-handoff-'))
    process.env.GUGU_SERVER_HOME = home
    const previous = '0.2.58-beta.100.1'
    const target = '0.2.58-beta.101.1'
    binary(previous, 'process.exit(0)')
    const readings = path.join(home, 'boot-processes.jsonl')
    const record = (fields = '') => `require('node:fs').appendFileSync(${JSON.stringify(readings)}, JSON.stringify({pid:process.pid, home:process.env.GUGU_SERVER_HOME, args:process.argv.slice(2),${fields}})+'\\n');`
    binary(target, `${record()}process.exit(1)`)
    pointCurrent(home, path.join(home, 'versions', previous))
    const lifecycle = createServerVersionLifecycle({ layout: { home, versions: path.join(home, 'versions'), version: previous } })
    const staged = vi.fn(async () => {}) // Cached directory already exists; no download is needed.
    await expect(lifecycle.stage(target, staged)).rejects.toThrow('Account boot exited before serving')
    expect(lifecycle.ready(target)).toBe(false)
    expect(() => lifecycle.switchSupervisor({ from: previous, to: target,
      fromDir: path.join(home!, 'versions', previous), toDir: path.join(home!, 'versions', target), switchedAt: 1 }, () => {})).toThrow('boot verification')
    expect(fs.readlinkSync(path.join(home, 'current'))).toBe(`versions/${previous}`)
    binary(target, `${realSignalExit()}let activityWrites=0;process.on('exit',()=>{${record('activityWrites')}});const d=process.env.GUGU_TASK_HOST_USER_DATA;require('node:fs').mkdirSync(d,{recursive:true});const startedAt=Date.now();const reportActivity=()=>{require('node:fs').writeFileSync(require('node:path').join(d,'activity.json'),JSON.stringify({pid:process.pid,startedAt,at:Date.now(),busy:false,runtimeOwned:true}));activityWrites++};reportActivity();setInterval(reportActivity,10_000)`)
    try {
      await lifecycle.stage(target, staged)
    } finally {
      console.info('Boot smoke process readings:', fs.readFileSync(readings, 'utf8'))
    }
    expect(lifecycle.ready(target)).toBe(true)
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
})
