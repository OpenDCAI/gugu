import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServerUpdateStateWriter } from '../../../../apps/desktop/electron/server/server-update-state'
import { activateServerPackage, createServerVersionLifecycle, pointCurrent } from '../../../../apps/desktop/electron/server/server-version-lifecycle'
import { markServerReady, readPendingVerify, writePendingVerify } from '../../../../apps/desktop/electron/server/server-startup'

let home: string
const saved = process.env.GUGU_SERVER_HOME
const now = 1_800_000_000_000
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-version941-')))
  process.env.GUGU_SERVER_HOME = home
  for (const version of ['1.0.0', '2.0.0', '3.0.0', '4.0.0', '5.0.0']) {
    fs.mkdirSync(path.join(home, 'versions', version, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(home, 'versions', version, 'bin', 'gugu-server'), '')
  }
  pointCurrent(home, path.join(home, 'versions', '3.0.0'))
})
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); if (saved === undefined) delete process.env.GUGU_SERVER_HOME; else process.env.GUGU_SERVER_HOME = saved })
const layout = () => ({ home, versions: path.join(home, 'versions'), version: '3.0.0' })


describe('one installation version lifecycle', () => {
  it('rechecks bad versions at the shared activation commit even after successful staging', async () => {
    const lifecycle = createServerVersionLifecycle({ verifyBoot: async () => undefined, layout: layout() })
    await lifecycle.stage('4.0.0', async () => {})
    fs.mkdirSync(path.join(home, 'data'))
    fs.writeFileSync(path.join(home, 'data/bad-versions.json'), JSON.stringify({ '4.0.0': now }))
    const beforeSwitch = vi.fn()
    expect(() => lifecycle.switchSupervisor({ from: '3.0.0', to: '4.0.0', fromDir: path.join(home, 'versions/3.0.0'),
      toDir: path.join(home, 'versions/4.0.0'), switchedAt: now }, beforeSwitch)).toThrow('previously failed')
    expect(beforeSwitch).not.toHaveBeenCalled()
    expect(readPendingVerify(home)).toBeNull()
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(path.join(home, 'versions/3.0.0'))
  })
  it('retains actual current, explicit previous, live processes and a staging lease; reclaims only unowned directories', async () => {
    createServerUpdateStateWriter(home).set('idle', '3.0.0', undefined, { previous: '2.0.0' })
    const lifecycle = createServerVersionLifecycle({ verifyBoot: async () => undefined, layout: layout(), running: () => ['1.0.0'] })
    let release!: () => void
    const staged = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const first = lifecycle.stage('4.0.0', staged)
    const second = lifecycle.stage('4.0.0', staged)
    expect(staged).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(lifecycle.reclaim()).toEqual(['5.0.0'])
    expect(fs.existsSync(path.join(home, 'versions', '4.0.0'))).toBe(true)
    release(); await Promise.all([first, second])
    expect(lifecycle.reclaim()).toEqual(['4.0.0'])
    expect(fs.readdirSync(path.join(home, 'versions')).sort()).toEqual(['1.0.0', '2.0.0', '3.0.0'])
  })
  it('does not guess a legacy previous version from directory numbers or mtimes', () => {
    expect(createServerVersionLifecycle({ verifyBoot: async () => undefined, layout: layout() }).reclaim()).toEqual([])
    expect(fs.readdirSync(path.join(home, 'versions'))).toHaveLength(5)
  })
  it('protects an installer-prepared target until an account adopts it through the same owner', async () => {
    createServerUpdateStateWriter(home).set('idle', '3.0.0', undefined, { previous: '2.0.0' })
    const lifecycle = createServerVersionLifecycle({ verifyBoot: async () => undefined, layout: layout() })
    const prepared = path.join(home, 'versions', '.prepared', '4.0.0')
    fs.mkdirSync(path.dirname(prepared)); fs.writeFileSync(prepared, '')
    expect(lifecycle.reclaim()).not.toContain('4.0.0')
    await lifecycle.stage('4.0.0', async () => {})
    // The newly stable run releases its lease and records its actual rollback source.
    pointCurrent(home, path.join(home, 'versions/4.0.0'))
    fs.rmSync(prepared)
    writePendingVerify(home, { from: '3.0.0', to: '4.0.0', attempts: 1 })
    vi.stubEnv('GUGU_TASK_HOST_VERSION', '4.0.0')
    markServerReady(home, now)
    expect(lifecycle.reclaim()).not.toContain('4.0.0')
  })
  it.each(['automatic', 'controller'])('synchronizes a stale pin only on verified readiness after %s activation', async activation => {
    const lifecycle = createServerVersionLifecycle({ verifyBoot: async () => undefined, layout: layout() })
    const next = { from: '3.0.0', to: '4.0.0', fromDir: path.join(home, 'versions', '3.0.0'), toDir: path.join(home, 'versions', '4.0.0'), switchedAt: now }
    const pin = path.join(home, 'data/server-version.json')
    const oldPin = JSON.stringify({ version: '1.0.0', previous: null, at: 1 })
    fs.mkdirSync(path.dirname(pin), { recursive: true }); fs.writeFileSync(pin, oldPin)
    const beforeSwitch = () => {
      expect(readPendingVerify(home)).toEqual({ from: '3.0.0', to: '4.0.0', attempts: 0 })
      expect(fs.realpathSync(path.join(home, 'current'))).toBe(next.fromDir)
    }
    if (activation === 'automatic') {
      await lifecycle.stage('4.0.0', async () => {})
      lifecycle.switchSupervisor(next, beforeSwitch)
    } else await activateServerPackage(home, next.toDir, { verifyBoot: async () => {}, isBusy: () => false, beforeSwitch })
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(next.toDir)
    vi.stubEnv('GUGU_TASK_HOST_VERSION', '3.0.0')
    markServerReady(home, now)
    expect(fs.readFileSync(pin, 'utf8')).toBe(oldPin)
    expect(readPendingVerify(home)?.to).toBe('4.0.0')
    vi.stubEnv('GUGU_TASK_HOST_VERSION', '4.0.0')
    markServerReady(home, now)
    expect(readPendingVerify(home)).toBeNull()
    expect(JSON.parse(fs.readFileSync(path.join(home, 'data/server-update.json'), 'utf8'))).toMatchObject({ state: 'idle', lastOutcome: { kind: 'switched', target: '4.0.0' } })
    expect(JSON.parse(fs.readFileSync(pin, 'utf8'))).toEqual({ version: '4.0.0', previous: '3.0.0', at: now })
    markServerReady(home, now + 1)
    expect(JSON.parse(fs.readFileSync(pin, 'utf8')).at).toBe(now)
  })
  it('retains pending verification and the old pin when its atomic projection fails, then retries readiness', async () => {
    const lifecycle = createServerVersionLifecycle({ verifyBoot: async () => {}, layout: layout() })
    await lifecycle.stage('4.0.0', async () => {})
    lifecycle.switchSupervisor({ from: '3.0.0', to: '4.0.0', fromDir: path.join(home, 'versions/3.0.0'),
      toDir: path.join(home, 'versions/4.0.0'), switchedAt: now }, () => {})
    const pin = path.join(home, 'data/server-version.json')
    const oldPin = JSON.stringify({ version: '1.0.0', previous: null, at: 1 })
    fs.writeFileSync(pin, oldPin)
    vi.stubEnv('GUGU_TASK_HOST_VERSION', '4.0.0')
    const rename = fs.renameSync
    const fault = vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (target === pin) throw new Error('pin projection refused')
      return rename(source, target)
    })
    try {
      expect(() => markServerReady(home, now)).toThrow('pin projection refused')
      expect(fs.readFileSync(pin, 'utf8')).toBe(oldPin)
      expect(readPendingVerify(home)?.to).toBe('4.0.0')
    } finally { fault.mockRestore() }
    markServerReady(home, now)
    expect(JSON.parse(fs.readFileSync(pin, 'utf8'))).toEqual({ version: '4.0.0', previous: '3.0.0', at: now })
    expect(readPendingVerify(home)).toBeNull()
  })
  it('keeps the pending rollback package throughout a slow startup', () => {
    createServerUpdateStateWriter(home).set('idle', '3.0.0', undefined, { previous: '2.0.0' })
    writePendingVerify(home, { from: '4.0.0', to: '3.0.0', attempts: 1 })
    const lifecycle = createServerVersionLifecycle({ verifyBoot: async () => undefined, layout: layout() })
    expect(lifecycle.reclaim()).not.toContain('4.0.0')
    expect(fs.existsSync(path.join(home, 'versions/4.0.0/bin/gugu-server'))).toBe(true)
  })
})
