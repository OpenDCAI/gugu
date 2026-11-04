import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), installed: vi.fn(), supervisor: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/server/server-account-runtime', () => ({ readAccountRuntime: mocks.runtime, installedPackageVersion: mocks.installed }))
vi.mock('../../../../apps/desktop/electron/server/server-service', () => ({ describeService: () => 'test supervisor', readRunningServer: mocks.supervisor }))
vi.mock('../../../../apps/desktop/electron/server/server-electron-shim', () => ({ default: {} }))

const argv = process.argv
const loader = Module as unknown as { _load: unknown }
const originalLoad = loader._load
let home: string

afterEach(() => {
  loader._load = originalLoad
  process.argv = argv
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (home) fs.rmSync(home, { recursive: true, force: true })
})

it.each(['running', 'stopped', 'waiting', 'migration'] as const)('status --json preserves truthful marked output when %s', async state => {
  vi.resetModules()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-status-entry-1003-'))
  vi.stubEnv('GUGU_SERVER_HOME', home)
  vi.stubEnv('GUGU_TIER', 'beta')
  vi.stubEnv('GUGU_SERVER_MODE', undefined)
  vi.stubEnv('GUGU_TASK_HOST_VERSION', 'cli-package')
  process.argv = ['node', 'server-entry.js', 'status', '--json']
  if (state !== 'waiting') {
    for (const id of state === 'migration' ? ['u1', 'u2'] : ['u1']) {
      const dir = state === 'migration' ? path.join(home, 'accounts', id) : path.join(home, 'account')
      fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ userId: id, email: `${id}@example.test` }))
      fs.writeFileSync(path.join(dir, 'data/server-session.enc'), 'fixture')
    }
  }
  const active = state === 'running' || state === 'waiting'
  mocks.runtime.mockReturnValue(active ? { pid: 42, version: 'actual-account' } : { pid: null, version: null })
  mocks.installed.mockReturnValue('installed-package')
  mocks.supervisor.mockReturnValue(active ? { pid: 7, version: 'actual-supervisor', supervisedBy: 'systemd' } : null)
  let stdout = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout += String(chunk); return true })
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  await import('../../../../apps/desktop/electron/server-entry')
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 2_000 })
  const json = JSON.parse(stdout.split('__GUGU_STATUS_BEGIN__\n')[1]!.split('\n__GUGU_STATUS_END__')[0]!)
  expect(stdout.match(/__GUGU_STATUS_BEGIN__/g)).toHaveLength(1)
  expect(stdout.match(/__GUGU_STATUS_END__/g)).toHaveLength(1)
  expect(json).toMatchObject({ version: 'cli-package', installedVersion: 'installed-package', supervisorVersion: active ? 'actual-supervisor' : null })
  expect(json.accounts).toHaveLength(state === 'waiting' ? 0 : state === 'migration' ? 2 : 1)
  if (state === 'running') {
    expect(json.accounts[0]).toMatchObject({ userId: 'u1', running: true, version: 'actual-account' })
    expect(mocks.runtime).toHaveBeenCalledWith(path.join(home, 'account/data'))
  }
  if (state === 'migration') {
    expect(json.migrationRequired).toBe(true)
    expect(json.accounts.map((account: { userId: string }) => account.userId)).toEqual(['u1', 'u2'])
    expect(stdout).toContain('gugu-server start')
    expect(fs.existsSync(path.join(home, 'account'))).toBe(false)
    expect(fs.readdirSync(path.join(home, 'accounts'))).toEqual(['u1', 'u2'])
  }
  expect(exit).toHaveBeenCalledTimes(1)
})
