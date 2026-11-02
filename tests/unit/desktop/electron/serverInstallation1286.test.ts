import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertPackageEnvironment, assertRuntimeBackend, controllerOwnsUpdates, packageBackend, prepareInstallation, readInstallation, SERVER_INSTALLATION } from '../../../../apps/desktop/electron/server/server-installation.mts'
import { createServerVersionLifecycle, pointCurrent } from '../../../../apps/desktop/electron/server/server-version-lifecycle'
import { startServerUpdater } from '../../../../apps/desktop/electron/server/server-updater'

const A = 'https://backend-a.example.test'
const B = 'https://backend-b.example.test'
const identity = (backendUrl = A, channel = 'beta') => ({ schema: 1 as const, backendUrl, channel })
let home: string
let environment: NodeJS.ProcessEnv

function candidate(version: string, backend = A, legacy = false): string {
  const directory = path.join(home, 'versions', version)
  const dist = path.join(directory, 'app', 'dist-electron')
  fs.mkdirSync(dist, { recursive: true })
  fs.mkdirSync(path.join(directory, 'bin'))
  fs.writeFileSync(path.join(directory, 'bin', 'gugu-server'), '')
  if (legacy) fs.writeFileSync(path.join(dist, 'server.js'), `const __vite_import_meta_env__ = ${JSON.stringify({ VITE_SUPABASE_URL: backend })};`)
  else fs.writeFileSync(path.join(dist, 'server-build.json'), JSON.stringify(identity(backend)))
  return directory
}

beforeEach(() => {
  environment = { ...process.env }
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-installation1286-')))
  process.env.GUGU_SERVER_HOME = home
  delete process.env.GUGU_CLOUD_COMPUTER
})
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals()
  process.env = environment
  fs.rmSync(home, { recursive: true, force: true })
})

describe('installation backend and package ownership', () => {
  it('rejects a runtime backend override before account startup', () => {
    expect(() => assertRuntimeBackend(identity(), B)).toThrow('another backend')
    expect(() => assertRuntimeBackend(identity(), `${A}/`)).not.toThrow()
    expect(() => assertRuntimeBackend(identity(), `${A}/?token=secret`)).toThrow('Invalid server backend')
  })
  it('binds a new installation and persists controller ownership across restarts with a smaller environment', () => {
    prepareInstallation(home, identity(), { updateOwner: 'controller' })
    prepareInstallation(home, identity())
    expect(readInstallation(home)).toEqual({ ...identity(), updateOwner: 'controller' })
    expect(controllerOwnsUpdates(home, {})).toBe(true)
  })

  it('migrates an inspectable legacy backend, corrects discovery, and preserves account data', () => {
    const old = candidate('1.0.0', A, true)
    fs.symlinkSync(old, path.join(home, 'current'))
    fs.writeFileSync(path.join(home, 'channel'), 'stable\n')
    const account = path.join(home, 'accounts', 'original', 'data')
    fs.mkdirSync(account, { recursive: true })
    fs.writeFileSync(path.join(account, 'server-session.enc'), 'original encrypted credentials')
    prepareInstallation(home, identity(), { updateOwner: 'controller', migrateFrom: '1.0.0' })
    expect(fs.readFileSync(path.join(home, 'channel'), 'utf8')).toBe('beta\n')
    expect(fs.readFileSync(path.join(account, 'server-session.enc'), 'utf8')).toBe('original encrypted credentials')
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(old)
  })

  it('rejects a candidate from another backend without changing current or account state', async () => {
    const previous = candidate('1.0.0')
    const wrong = candidate('2.0.0', B)
    fs.symlinkSync(previous, path.join(home, 'current'))
    prepareInstallation(home, identity())
    const before = fs.readFileSync(path.join(home, SERVER_INSTALLATION), 'utf8')
    const verifyBoot = vi.fn()
    const lifecycle = createServerVersionLifecycle({ layout: { home, versions: path.join(home, 'versions'), version: '1.0.0' }, verifyBoot })
    await expect(lifecycle.stage('2.0.0', async () => {})).rejects.toThrow('another backend')
    expect(verifyBoot).not.toHaveBeenCalled()
    expect(() => pointCurrent(home, wrong)).toThrow('another backend')
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(previous)
    expect(fs.readFileSync(path.join(home, SERVER_INSTALLATION), 'utf8')).toBe(before)
  })

  it('rechecks activation after staging and accepts a same-backend historical rollback', async () => {
    const previous = candidate('1.0.0', A, true)
    const target = candidate('2.0.0')
    fs.symlinkSync(previous, path.join(home, 'current'))
    prepareInstallation(home, identity())
    const lifecycle = createServerVersionLifecycle({ layout: { home, versions: path.join(home, 'versions'), version: '1.0.0' }, verifyBoot: async () => {} })
    await lifecycle.stage('2.0.0', async () => {})
    fs.writeFileSync(path.join(target, 'app', 'dist-electron', 'server-build.json'), JSON.stringify(identity(B)))
    const beforeSwitch = vi.fn()
    expect(() => lifecycle.switchSupervisor({ from: '1.0.0', to: '2.0.0', fromDir: previous, toDir: target, switchedAt: Date.now() }, beforeSwitch)).toThrow('another backend')
    expect(beforeSwitch).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(home, 'data', 'upgrade-pending.json'))).toBe(false)
    expect(() => pointCurrent(home, previous)).not.toThrow()
  })

  it('uses the old updater source when current already points to the wrong candidate', () => {
    candidate('1.0.0', A, true)
    const wrong = candidate('2.0.0', B)
    fs.symlinkSync(wrong, path.join(home, 'current'))
    fs.mkdirSync(path.join(home, 'data'))
    fs.writeFileSync(path.join(home, 'data', 'upgrade-pending.json'), JSON.stringify({ from: '1.0.0' }))
    expect(() => prepareInstallation(home, identity(B, 'stable'))).toThrow('another backend')
    expect(readInstallation(home)).toBeNull()
  })

  it('requires explicit migration evidence when the original installation is ambiguous', () => {
    const wrong = candidate('2.0.0', B)
    candidate('1.0.0', A, true)
    fs.symlinkSync(wrong, path.join(home, 'current'))
    expect(() => prepareInstallation(home, identity())).toThrow('another backend')
    prepareInstallation(home, identity(), { updateOwner: 'controller', migrateFrom: '1.0.0' })
    expect(readInstallation(home)?.backendUrl).toBe(A)
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(wrong)
    expect(() => assertPackageEnvironment(home, wrong)).toThrow('another backend')
  })

  it('does not let a legacy managed self-update use its own current package to adopt existing accounts', () => {
    const wrong = candidate('2.0.0', B)
    const original = candidate('1.0.0', A, true)
    fs.symlinkSync(wrong, path.join(home, 'current'))
    const data = path.join(home, 'accounts', 'original', 'data')
    fs.mkdirSync(data, { recursive: true })
    fs.writeFileSync(path.join(data, 'server-session.enc'), 'original credentials')
    expect(() => prepareInstallation(home, identity(B, 'stable'), { updateOwner: 'controller' })).toThrow('verified migration source')
    expect(readInstallation(home)).toBeNull()
    prepareInstallation(home, identity(), { updateOwner: 'controller', migrateFrom: path.basename(original) })
    expect(readInstallation(home)?.backendUrl).toBe(A)
    expect(fs.readFileSync(path.join(data, 'server-session.enc'), 'utf8')).toBe('original credentials')
  })

  it('does not infer an environment from an unreadable or mixed legacy package', () => {
    const old = candidate('1.0.0', A, true)
    fs.writeFileSync(path.join(old, 'app', 'dist-electron', 'other.js'), `const __vite_import_meta_env__ = ${JSON.stringify({ VITE_SUPABASE_URL: B })};`)
    expect(() => packageBackend(old)).toThrow('cannot be verified')
  })
})

describe('one package selector for a managed installation', () => {
  it.each(['record', 'legacy environment'])('never polls the release feed with controller ownership from %s', async source => {
    vi.useFakeTimers()
    if (source === 'record') prepareInstallation(home, identity(), { updateOwner: 'controller' })
    else process.env.GUGU_CLOUD_COMPUTER = '1'
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const stateWriter = { set: vi.fn(), clear: vi.fn() }
    const stop = startServerUpdater({ lifecycle: null, log: { info: vi.fn(), warn: vi.fn() }, isBusy: () => false, shutdown: vi.fn(), stateWriter })
    await vi.advanceTimersByTimeAsync(61 * 60_000)
    expect(fetch).not.toHaveBeenCalled()
    expect(stateWriter.clear).not.toHaveBeenCalled()
    stop()
  })
})
