import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertPackageEnvironment, assertRuntimeBackend, controllerOwnsUpdates, packageBackend, prepareInstallation, readInstallation, SERVER_INSTALLATION } from '../../../../apps/desktop/electron/server/server-package-environment.mts'
import { activateServerPackage, createServerVersionLifecycle, pointCurrent, readUpgradeMarker } from '../../../../apps/desktop/electron/server/server-version-lifecycle'
import { rollbackUpgrade } from '../../../../apps/desktop/electron/server/server-upgrade-guard'
import { guardReplacement, installServiceWith } from '../../../../apps/desktop/electron/server/server-service'
import { startServerUpdater } from '../../../../apps/desktop/electron/server/server-updater'
import { createAccountDriver } from '../../../../apps/desktop/electron/server/server-account-driver'
import { INITIAL_ACCOUNT_STATE, writeAccountState } from '../../../../apps/desktop/electron/server/server-account-machine'

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
  it.each(['server', 'controller'] as const)('initializes a never-used whole home created by an older account boot checker (%s)', updateOwner => {
    for (const id of ['first', 'second']) {
      const directory = path.join(home, 'accounts', id)
      fs.mkdirSync(path.join(directory, 'data'), { recursive: true })
      fs.writeFileSync(path.join(directory, 'account.json'), '{}')
    }
    expect(prepareInstallation(home, identity(), { updateOwner })).toEqual({ ...identity(), updateOwner })
  })

  it.each(['home entry', 'another account data', 'account entry', 'account metadata'])('keeps rejecting an unverified installation with a skeleton and %s', extra => {
    const directory = path.join(home, 'accounts', 'unused')
    fs.mkdirSync(path.join(directory, 'data'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'account.json'), '{}')
    if (extra === 'home entry') fs.writeFileSync(path.join(home, 'channel'), 'beta')
    if (extra === 'another account data') {
      const data = path.join(home, 'accounts', 'existing', 'data')
      fs.mkdirSync(data, { recursive: true })
      fs.writeFileSync(path.join(home, 'accounts', 'existing', 'account.json'), '{}')
      fs.writeFileSync(path.join(data, 'sessions.db'), 'existing account state')
    }
    if (extra === 'account entry') fs.writeFileSync(path.join(directory, 'name'), 'existing name')
    if (extra === 'account metadata') fs.writeFileSync(path.join(directory, 'account.json'), '{"addedAt":"existing"}')
    expect(() => prepareInstallation(home, identity())).toThrow('Existing account environment cannot be verified')
    expect(readInstallation(home)).toBeNull()
  })

  it('keeps standalone historical first installation while refusing an unverifiable existing or managed installation', () => {
    const source = path.join(home, 'archive', 'gugu-server-1.0.0')
    fs.mkdirSync(path.join(source, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(source, 'bin', 'gugu-server'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const archive = path.join(home, 'historical.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', path.dirname(source), path.basename(source)])
    const sha = createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
    const install = (root: string, owner: string) => spawnSync('sh', [path.resolve('scripts/gugu-server/install.sh'),
      '--package', archive, '--version', '1.0.0', '--sha256', sha, '--update-owner', owner, '--no-service', '--no-login'],
    { env: { ...process.env, HOME: path.join(home, 'user'), GUGU_SERVER_HOME: root }, encoding: 'utf8' })
    const standalone = path.join(home, 'standalone')
    const first = install(standalone, 'server')
    expect(first.status, first.stderr).toBe(0)
    expect(fs.readlinkSync(path.join(standalone, 'current'))).toBe('versions/1.0.0')
    const data = path.join(standalone, 'accounts', 'original', 'data')
    fs.mkdirSync(data, { recursive: true })
    fs.writeFileSync(path.join(data, 'server-session.enc'), 'original credentials')
    expect(install(standalone, 'server').status).not.toBe(0)
    expect(fs.readFileSync(path.join(data, 'server-session.enc'), 'utf8')).toBe('original credentials')
    const managed = path.join(home, 'managed')
    expect(install(managed, 'controller').status).not.toBe(0)
    expect(fs.existsSync(path.join(managed, 'current'))).toBe(false)
  })

  it.each([A, B])('checks the actual account rollback executable against the installation (%s)', async backend => {
    candidate('2.0.0')
    const old = candidate('1.0.0', backend, true)
    prepareInstallation(home, identity(), { updateOwner: 'controller' })
    const userId = '00000000-0000-4000-8000-000000000001'
    const dir = path.join(home, 'accounts', userId), dataDir = path.join(dir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'server-session.enc'), 'original credentials')
    writeAccountState(dataDir, { ...INITIAL_ACCOUNT_STATE, version: '2.0.0', previous: '1.0.0',
      phase: { kind: 'booting', since: 1, quickExits: 0 } }, 1)
    const account = { userId, dir, dataDir, homeDir: path.join(dir, 'home'), email: null, addedAt: null, signedIn: true, signedOut: null }
    const driver = createAccountDriver({ layout: { home, versions: path.join(home, 'versions'), version: '2.0.0' },
      lifecycle: createServerVersionLifecycle({ layout: { home, versions: path.join(home, 'versions'), version: '2.0.0' }, verifyBoot: async () => { throw new Error('new package failed to boot') } }),
      followSupervisor: true, log: { info: vi.fn(), warn: vi.fn() }, child: () => undefined, started: () => false, restart: vi.fn(), now: () => 2 })
    for (let i = 0; i < 3; i++) driver.childExited(account, true)
    driver.tick([account])
    await driver.settled()
    expect(driver.binaryFor(userId)).toEqual(backend === A ? { binary: path.join(old, 'bin', 'gugu-server'), version: '1.0.0' } : 'none')
    expect(fs.readFileSync(path.join(dataDir, 'server-session.enc'), 'utf8')).toBe('original credentials')
  })

  it('preserves a verified legacy rollback source before service replacement, including when the replacement cannot start', async () => {
    const original = candidate('1.0.0', A, true)
    const wrong = candidate('2.0.0', B)
    const target = candidate('3.0.0')
    fs.symlinkSync(wrong, path.join(home, 'current'))
    prepareInstallation(home, identity(), { updateOwner: 'controller', migrateFrom: '1.0.0' })
    const guard = vi.fn(() => {
      expect(readUpgradeMarker(home)?.fromDir).toBe(original)
      expect(fs.realpathSync(path.join(home, 'current'))).toBe(wrong)
    })
    await activateServerPackage(home, target, { migrateFrom: '1.0.0', verifyBoot: async () => {}, isBusy: () => false, beforeSwitch: guard })
    expect(guard).toHaveBeenCalledOnce()
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(target)
    // Service install must retain the controller's verified original, rather than overwrite
    // it with the old process's already-wrong backend version.
    guardReplacement(home, { pid: 1, version: '2.0.0', supervisedBy: 'systemd' }, '3.0.0')
    expect(readUpgradeMarker(home)?.fromDir).toBe(original)
    let clock = 0
    const started = await installServiceWith(() => {}, { mode: 'systemd', targetVersion: '3.0.0', running: () => null,
      isAlive: () => false, isBusy: () => false, requireIdle: true, stop: vi.fn(),
      registerSystemd: vi.fn(), registerLaunchd: vi.fn(), registerCron: () => true, startDetached: vi.fn(),
      logHint: 'isolated test', user: 'test', sleep: async ms => { clock += ms }, now: () => clock })
    expect(started).toBe(false)
    const marker = readUpgradeMarker(home)!
    expect(marker.from).toBe('1.0.0')
    expect(await rollbackUpgrade(home, marker, { now: () => clock, lockHolder: () => null, kill: vi.fn(), isAlive: () => false,
      sleep: async () => {}, restartsAutomatically: () => true, startKeeper: vi.fn(), log: vi.fn() })).toBe(true)
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(original)
  })

  it('rechecks idle after the activation boot check before publishing a pointer or stopping a service', async () => {
    const original = candidate('1.0.0'), target = candidate('2.0.0')
    fs.symlinkSync(original, path.join(home, 'current'))
    prepareInstallation(home, identity(), { updateOwner: 'controller' })
    const beforeSwitch = vi.fn()
    let busy = false
    await expect(activateServerPackage(home, target, { verifyBoot: async () => { busy = true }, isBusy: () => busy, beforeSwitch }))
      .rejects.toThrow('no longer idle')
    expect(beforeSwitch).not.toHaveBeenCalled()
    expect(readUpgradeMarker(home)).toBeNull()
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(original)
  })

  it('keeps a rolled-back package blocked across controller wakes and permits a different release', async () => {
    const original = candidate('1.0.0'), rejected = candidate('2.0.0'), next = candidate('3.0.0')
    fs.symlinkSync(original, path.join(home, 'current'))
    prepareInstallation(home, identity(), { updateOwner: 'controller' })
    const verifyBoot = vi.fn(async () => {}), beforeSwitch = vi.fn()
    const options = { verifyBoot, beforeSwitch, isBusy: () => false }
    await activateServerPackage(home, rejected, options)
    expect(await rollbackUpgrade(home, readUpgradeMarker(home)!, { now: () => 123, lockHolder: () => null, kill: vi.fn(), isAlive: () => false,
      sleep: async () => {}, restartsAutomatically: () => true, startKeeper: vi.fn(), log: vi.fn() })).toBe(true)
    await expect(activateServerPackage(home, rejected, options)).rejects.toThrow('previously failed')
    expect(verifyBoot).toHaveBeenCalledOnce()
    expect(beforeSwitch).toHaveBeenCalledOnce()
    expect(readUpgradeMarker(home)).toBeNull()
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(original)
    await activateServerPackage(home, next, options)
    expect(beforeSwitch).toHaveBeenCalledTimes(2)
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(next)
  })

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
