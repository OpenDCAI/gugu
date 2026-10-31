import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), installed: vi.fn(), supervisor: vi.fn(), accounts: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/server/server-account-runtime', () => ({ readAccountRuntime: mocks.runtime, installedPackageVersion: mocks.installed }))
vi.mock('../../../../apps/desktop/electron/server/server-service', () => ({ describeService: () => 'test supervisor', readRunningServer: mocks.supervisor }))
vi.mock('../../../../apps/desktop/electron/server/server-layout', () => ({
  accountDataDir: (id: string) => `/accounts/${id}/data`, applyAccountEnv: () => undefined,
  listAccounts: mocks.accounts, supervisorDataDir: () => '/supervisor/data',
}))
vi.mock('../../../../apps/desktop/electron/server/server-electron-shim', () => ({ default: {} }))
vi.mock('../../../../apps/desktop/electron/server/server-version-match', () => ({ runWithRunningVersion: () => null }))

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

it('status --json wires installation, live supervisor, and live account identities through the real command entry', async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-status-entry-1003-'))
  vi.stubEnv('GUGU_SERVER_HOME', home)
  vi.stubEnv('GUGU_TIER', 'beta')
  vi.stubEnv('GUGU_SERVER_MODE', undefined)
  vi.stubEnv('GUGU_TASK_HOST_VERSION', 'cli-package')
  process.argv = ['node', 'server-entry.js', 'status', '--json']
  mocks.runtime.mockReturnValue({ pid: 42, version: 'actual-account' })
  mocks.installed.mockReturnValue('installed-package')
  mocks.supervisor.mockReturnValue({ pid: 7, version: 'actual-supervisor', supervisedBy: 'systemd' })
  mocks.accounts.mockReturnValue([{ userId: 'u1', email: 'test@example.test', signedIn: true, signedOut: null, dataDir: '/accounts/u1/data' }])
  let stdout = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true })
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  await import('../../../../apps/desktop/electron/server-entry')
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 2_000 })
  const json = JSON.parse(stdout.split('__GUGU_STATUS_BEGIN__\n')[1]!.split('\n__GUGU_STATUS_END__')[0]!)
  expect(json).toMatchObject({ version: 'cli-package', installedVersion: 'installed-package', supervisorVersion: 'actual-supervisor', accounts: [{ userId: 'u1', running: true, version: 'actual-account' }] })
  expect(mocks.installed).toHaveBeenCalledWith(home)
  expect(mocks.runtime).toHaveBeenCalledWith('/accounts/u1/data')
  expect(exit).toHaveBeenCalledTimes(1)
})
