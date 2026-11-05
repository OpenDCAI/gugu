import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serverLauncher } from '../../../../scripts/gugu-server/launcher.mjs'

let home: string
const children: ChildProcess[] = []
const data = (name: string) => path.join(home, 'data', name)
const app = () => path.join(home, 'versions/2.0.0/app/dist-electron/server.js')
const command = () => path.join(home, 'current/bin/gugu-server')
const environment = () => ({ HOME: home, PATH: process.env.PATH, GUGU_SERVER_HOME: home, GUGU_SERVER_SUPERVISED: 'keeper' })
const read = (name: string) => JSON.parse(fs.readFileSync(data(name), 'utf8'))
function pending(): void {
  fs.writeFileSync(data('pending-verify.json'), JSON.stringify({ from: '1.0.0', to: '2.0.0', attempts: 0, request: 42 }))
}
function run(args = ['run']) {
  return spawnSync(command(), args, { env: environment(), encoding: 'utf8' })
}
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gugu launcher ')))
  fs.mkdirSync(data(''), { recursive: true })
  fs.writeFileSync(path.join(home, 'channel'), 'stable')
  for (const version of ['1.0.0', '2.0.0']) {
    const dir = path.join(home, 'versions', version)
    for (const sub of ['bin', 'node/bin', 'app/dist-electron']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
    fs.symlinkSync(process.execPath, path.join(dir, 'node/bin/node'))
    fs.copyFileSync(path.resolve('apps/desktop/electron/server/server-boot.cjs'), path.join(dir, 'app/dist-electron/server-boot.cjs'))
    fs.writeFileSync(path.join(dir, 'bin/gugu-server'), serverLauncher(version, 'stable'), { mode: 0o755 })
  }
  fs.symlinkSync('versions/2.0.0', path.join(home, 'current'))
})
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close')
      child.kill('SIGTERM')
      await closed
    }
  }
  fs.rmSync(home, { recursive: true, force: true })
})

describe('the packaged launcher verifies before loading application code', () => {
  it('counts three syntax failures and rolls back on the fourth launch before parsing server.js', () => {
    pending()
    const stalePin = JSON.stringify({ version: '0.9.0', previous: null, at: 1 })
    fs.writeFileSync(data('server-version.json'), stalePin)
    fs.writeFileSync(app(), 'const broken = ;')
    for (const attempt of [1, 2, 3]) {
      const result = run()
      expect(result.status, result.stderr).toBe(1)
      expect(result.stderr).toContain('SyntaxError')
      expect(read('pending-verify.json').attempts).toBe(attempt)
      expect(fs.existsSync(data('server.lock'))).toBe(false)
      expect(fs.readFileSync(data('server-version.json'), 'utf8')).toBe(stalePin)
    }
    const rolledBack = run()
    expect(rolledBack.status, rolledBack.stderr).toBe(75)
    expect(rolledBack.stderr).not.toContain('SyntaxError')
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(path.join(home, 'versions/1.0.0'))
    expect(read('bad-versions.json')['2.0.0']).toBeTypeOf('number')
    expect(read('server-update.json').lastOutcome).toMatchObject({ kind: 'rolledBack', bad: '2.0.0', back: '1.0.0', request: 42 })
    expect(read('server-version.json')).toEqual({ version: '1.0.0', previous: null, at: read('server-update.json').at })
    expect(fs.existsSync(data('pending-verify.json'))).toBe(false)
  })

  it('counts an application dependency failure before any startup body can run', () => {
    pending()
    fs.writeFileSync(app(), "require('./missing-native-addon.node')")
    const result = run()
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('MODULE_NOT_FOUND')
    expect(read('pending-verify.json').attempts).toBe(1)
  })

  it.each(['pin', 'current'])('retains the same verifier after a rollback %s failure, then hands off without old-package repair', faultTarget => {
    pending()
    const stalePin = JSON.stringify({ version: '0.9.0', previous: null, at: 1 })
    fs.writeFileSync(data('server-version.json'), stalePin)
    fs.writeFileSync(app(), 'const broken = ;')
    const oldApp = path.join(home, 'versions/1.0.0/app/dist-electron/server.js')
    fs.writeFileSync(oldApp, "process.stdout.write('old package without pin repair')")
    for (let attempt = 0; attempt < 3; attempt++) expect(run().status).toBe(1)
    const fault = path.join(home, 'pin-fault.cjs')
    const destination = faultTarget === 'pin' ? data('server-version.json') : path.join(home, 'current')
    fs.writeFileSync(fault, `const fs=require('node:fs'),rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b===${JSON.stringify(destination)})throw new Error('${faultTarget} rename refused');return rename(a,b)}`)
    const refused = spawnSync(command(), ['run'], { env: { ...environment(), NODE_OPTIONS: `--require ${JSON.stringify(fault)}` }, encoding: 'utf8' })
    expect(refused.status, refused.stderr).toBe(faultTarget === 'pin' ? 75 : 78)
    expect(refused.stderr).toContain(`${faultTarget} rename refused`)
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(path.join(home, 'versions/2.0.0'))
    expect(read('pending-verify.json').attempts).toBe(4)
    expect(fs.readFileSync(data('server-version.json'), 'utf8')).toBe(stalePin)
    expect(fs.existsSync(data('bad-versions.json'))).toBe(false)
    expect(fs.existsSync(data('server-update.json'))).toBe(false)
    const retried = run()
    expect(retried.status, retried.stderr).toBe(75)
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(path.join(home, 'versions/1.0.0'))
    expect(read('server-version.json')).toEqual({ version: '1.0.0', previous: null, at: read('server-update.json').at })
    expect(fs.existsSync(data('pending-verify.json'))).toBe(false)
    const old = run()
    expect(old.status, old.stderr).toBe(0)
    expect(old.stdout).toBe('old package without pin repair')
  })

  it('does not count a different running version against the pending target', () => {
    pending()
    const old = path.join(home, 'versions/1.0.0')
    fs.writeFileSync(path.join(old, 'app/dist-electron/server.js'), "process.stdout.write('old version')")
    const result = spawnSync(path.join(old, 'bin/gugu-server'), ['run'], { env: environment(), encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('old version')
    expect(read('pending-verify.json').attempts).toBe(0)
    expect(fs.existsSync(data('bad-versions.json'))).toBe(false)
  })

  it('waits for the previous server to exit before acquiring its lock', async () => {
    fs.writeFileSync(app(), "process.stdin.resume();process.stdout.write('ready');process.stdin.on('data',()=>process.exit(0))")
    const old = spawn(command(), ['run'], { env: environment(), stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(old)
    expect(String((await once(old.stdout!, 'data'))[0])).toBe('ready')
    const next = spawn(command(), ['run'], { env: { ...environment(), GUGU_SERVER_WAIT_PID: String(old.pid) }, stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(next)
    expect(String((await once(next.stderr!, 'data'))[0])).toContain('Waiting for previous server')
    const oldClosed = once(old, 'close')
    old.stdin!.end('exit'); await oldClosed
    expect(String((await once(next.stdout!, 'data'))[0])).toBe('ready')
    expect(fs.readFileSync(data('server.lock'), 'utf8')).toBe(String(next.pid))
    const nextClosed = once(next, 'close')
    next.stdin!.end('exit'); await nextClosed
    expect(next.exitCode).toBe(0)
  })

  it('owns the lock in the same PID as the body, including the default run command', () => {
    pending()
    fs.writeFileSync(app(), `const fs=require('node:fs');process.stdout.write(JSON.stringify({pid:process.pid,lock:fs.readFileSync(${JSON.stringify(data('server.lock'))},'utf8'),command:process.argv[2]}))`)
    const result = run([])
    expect(result.status, result.stderr).toBe(0)
    const body = JSON.parse(result.stdout)
    expect(body).toMatchObject({ lock: String(body.pid), command: 'run' })
    expect(read('pending-verify.json').attempts).toBe(1)
    expect(fs.existsSync(data('server.lock'))).toBe(false)
  })

  it.each([undefined, '131072'])('preserves the account allocator policy in the single process (%s)', override => {
    fs.writeFileSync(app(), 'process.stdout.write(process.env.MALLOC_MMAP_THRESHOLD_ ?? "unset")')
    const result = spawnSync(command(), ['run'], { env: { ...environment(), ...(override ? { MALLOC_MMAP_THRESHOLD_: override } : {}) }, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(override ?? (process.platform === 'linux' ? '16384' : 'unset'))
  })

  it.each(['run-account', 'status', 'selftest'])('%s bypasses home locking and attempts', verb => {
    pending()
    fs.writeFileSync(data('server.lock'), '12345')
    fs.writeFileSync(app(), 'process.stdout.write(process.argv[2])')
    const result = run([verb, 'fixture-account'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(verb)
    expect(read('pending-verify.json').attempts).toBe(0)
    expect(fs.readFileSync(data('server.lock'), 'utf8')).toBe('12345')
  })

  it('refuses a duplicate while a real server body is alive without counting or stopping it', async () => {
    pending()
    fs.writeFileSync(app(), "process.stdin.resume();process.stdout.write('ready');process.stdin.on('data',()=>process.exit(0))")
    const child = spawn(command(), ['run'], { env: environment(), stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    const [output] = await once(child.stdout!, 'data')
    expect(String(output)).toBe('ready')
    const files = ['logs/supervisor.log', 'supervisor-health.json'].map(data)
    fs.mkdirSync(data('logs'), { recursive: true })
    for (const file of files) fs.writeFileSync(file, 'active instance data', { mode: 0o644 })
    const snapshot = (file: string) => {
      const content = fs.readFileSync(file)
      const { dev, ino, mode, uid, gid, size, mtimeMs } = fs.statSync(file)
      return { content, dev, ino, mode, uid, gid, size, mtimeMs }
    }
    const before = files.map(snapshot)
    const accessBefore = files.map(file => fs.statSync(file).atimeMs)
    const result = run()
    expect(result.status, result.stderr).toBe(78)
    const after = files.map(snapshot)
    console.info('[launcher] access times (observation only)', {
      before: accessBefore, after: files.map(file => fs.statSync(file).atimeMs),
    })
    expect(after).toEqual(before)
    expect(read('pending-verify.json').attempts).toBe(1)
    expect(fs.readFileSync(data('server.lock'), 'utf8')).toBe(String(child.pid))
    expect(fs.existsSync(data('stopped'))).toBe(false)
    const closed = once(child, 'close')
    child.stdin!.end('exit')
    await closed
    expect(child.exitCode).toBe(0)
  })

  it('retains a damaged pending record and runs the current package without guessing a rollback', () => {
    fs.writeFileSync(data('pending-verify.json'), '{damaged')
    fs.writeFileSync(app(), "process.stdout.write('current started')")
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('INVALID STARTUP VERIFICATION')
    expect(result.stdout).toBe('current started')
    const evidence = fs.readdirSync(data('')).find(name => name.startsWith('pending-verify.json.invalid-'))!
    expect(fs.readFileSync(data(evidence), 'utf8')).toBe('{damaged')
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(path.join(home, 'versions/2.0.0'))
  })

  it.each([undefined, 3])('does not compete with the actual legacy guard (own attempts %s)', async attempts => {
    const guardScript = path.join(home, 'server.js')
    fs.writeFileSync(guardScript, "process.stdin.resume();process.stdout.write('guard');process.stdin.on('data',()=>process.exit(0))")
    const guard = spawn(process.execPath, [guardScript, 'upgrade-guard'], { env: environment(), stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(guard)
    expect(String((await once(guard.stdout!, 'data'))[0])).toBe('guard')
    const legacy = JSON.stringify({ from: '1.0.0', to: '2.0.0', fromDir: path.join(home, 'versions/1.0.0'), toDir: path.join(home, 'versions/2.0.0'), switchedAt: 123 })
    fs.writeFileSync(data('upgrade-pending.json'), legacy)
    fs.writeFileSync(data('upgrade-guard.pid'), String(guard.pid))
    if (attempts !== undefined) fs.writeFileSync(data('pending-verify.json'), JSON.stringify({ from: '1.0.0', to: '2.0.0', attempts }))
    fs.writeFileSync(app(), 'throw new Error("new package could not load")')
    const result = run()
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('legacy upgrade guard owns this transition')
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(path.join(home, 'versions/2.0.0'))
    expect(fs.existsSync(data('bad-versions.json'))).toBe(false)
    expect(fs.readFileSync(data('upgrade-pending.json'), 'utf8')).toBe(legacy)
    if (attempts === undefined) expect(fs.existsSync(data('pending-verify.json'))).toBe(false)
    else expect(read('pending-verify.json').attempts).toBe(attempts)
    const closed = once(guard, 'close')
    guard.stdin!.end('exit'); await closed
    if (attempts !== undefined) {
      expect(run().status).toBe(75)
      expect(read('bad-versions.json')['2.0.0']).toBeTypeOf('number')
    }
  })

  it('explains safe recovery from an empty lock without counting or loading the body', () => {
    pending()
    fs.writeFileSync(data('server.lock'), '')
    fs.writeFileSync(app(), "process.stdout.write('body must not run')")
    const result = run()
    expect(result.status, result.stderr).toBe(78)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Confirm that no server is running, then remove data/server.lock')
    expect(read('pending-verify.json').attempts).toBe(0)
  })
})
