import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'

const state = vi.hoisted(() => ({ alive: true, home: '', managed: false, account: false, stopSystemd: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/server/server-layout', async original => ({
  ...await original<typeof import('../../../../apps/desktop/electron/server/server-layout')>(),
  readServerAccount: () => state.account ? { userId: 'fixture', signedIn: true, dataDir: path.join(state.home, 'data') } : null, supervisorDataDir: () => path.join(state.home, 'data'),
}))
vi.mock('../../../../apps/desktop/electron/server/process-alive', async original => ({
  ...await original<typeof import('../../../../apps/desktop/electron/server/process-alive')>(),
  isProcessAlive: () => state.alive,
}))
vi.mock('../../../../apps/desktop/electron/server/server-electron-shim', () => ({ default: {} }))
// Package identity is unrelated to CLI exit ordering; retain the real logout and lock handling.
vi.mock('../../../../apps/desktop/electron/server/server-package-environment.mts', async original => ({
  ...await original<typeof import('../../../../apps/desktop/electron/server/server-package-environment.mts')>(),
  ownPackageIdentity: () => ({ schema: 1, backendUrl: 'https://fixture.invalid', channel: 'beta' }),
  assertRuntimeBackend: vi.fn(), prepareInstallation: vi.fn(),
}))
vi.mock('../../../../apps/desktop/electron/server/server-service', async original => ({
  ...await original<typeof import('../../../../apps/desktop/electron/server/server-service')>(),
  readRunningServer: () => state.managed ? { pid: 123456, version: '1.0.0', supervisedBy: 'systemd' } : null,
  stopSystemdService: () => { state.stopSystemd(); state.alive = false },
}))
const argv = process.argv
const loader = Module as unknown as { _load: unknown }
const originalLoad = loader._load

beforeEach(() => { vi.resetModules(); state.managed = false; state.account = false; state.stopSystemd.mockReset() })

afterEach(() => {
  loader._load = originalLoad
  process.argv = argv
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  console.info('Stop fixture cleanup:', state.home)
  expect(state.home.startsWith(path.join(os.tmpdir(), 'gugu-stop-escalation-'))).toBe(true)
  fs.rmSync(state.home, { recursive: true, force: true })
})

it('the real stop command escalates a locked process from TERM to KILL and reports it', async () => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-stop-escalation-'))
  fs.mkdirSync(path.join(state.home, 'data'))
  fs.writeFileSync(path.join(state.home, 'data/server.lock'), '123456')
  state.alive = true
  vi.stubEnv('GUGU_SERVER_HOME', state.home)
  vi.stubEnv('GUGU_TIER', 'beta')
  vi.stubEnv('GUGU_SERVER_MODE', undefined)
  process.argv = ['node', 'server-entry.js', 'stop']
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    expect(pid).toBe(123456)
    if (signal === 'SIGKILL') state.alive = false
    if (signal === 0 && !state.alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    return true
  })
  let stdout = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout += String(chunk); return true })
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  vi.useFakeTimers()
  await import('../../../../apps/desktop/electron/server-entry')
  await until('TERM sent to the locked pid', () => kill.mock.calls.some(([pid, signal]) => pid === 123456 && signal === 'SIGTERM'))
  await vi.runAllTimersAsync()
  expect(kill).toHaveBeenCalledWith(123456, 'SIGTERM')
  expect(kill).toHaveBeenCalledWith(123456, 'SIGKILL')
  expect(stdout).toContain('KILL for pid 123456')
  await until('the CLI exits 0', () => exit.mock.calls.some(([code]) => code === 0))
  expect(exit).not.toHaveBeenCalledWith(1)
})

async function cli(command: 'stop' | 'logout') {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-stop-escalation-'))
  fs.mkdirSync(path.join(state.home, 'data'))
  fs.writeFileSync(path.join(state.home, 'data/server.lock'), '123456')
  state.alive = true
  vi.stubEnv('GUGU_SERVER_HOME', state.home); vi.stubEnv('GUGU_TIER', 'beta'); vi.stubEnv('GUGU_SERVER_MODE', undefined)
  process.argv = ['node', 'server-entry.js', command]
  const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 'SIGKILL') state.alive = false
    if (signal === 0 && !state.alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    return true
  })
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.useFakeTimers()
  await import('../../../../apps/desktop/electron/server-entry')
  return { kill, exit }
}

it('stops a systemd-managed server through its manager without sending KILL', async () => {
  state.managed = true
  const { kill, exit } = await cli('stop')
  await until('the running pid is probed', () => kill.mock.calls.some(([pid, signal]) => pid === 123456 && signal === 0))
  await vi.runAllTimersAsync()
  await until('the CLI exits 0', () => exit.mock.calls.some(([code]) => code === 0))
  expect(state.stopSystemd).toHaveBeenCalledOnce()
  expect(kill).not.toHaveBeenCalledWith(123456, 'SIGTERM')
  expect(kill).not.toHaveBeenCalledWith(123456, 'SIGKILL')
})
it('logout returns only after the outgoing account process has exited', async () => {
  state.account = true
  const { kill, exit } = await cli('logout')
  await until('TERM sent to the account pid', () => kill.mock.calls.some(([pid, signal]) => pid === 123456 && signal === 'SIGTERM'))
  expect(exit).not.toHaveBeenCalled()
  state.alive = false
  await vi.runAllTimersAsync()
  await until('the CLI exits 0', () => exit.mock.calls.some(([code]) => code === 0))
})
it('logout reports failure if its bounded exit wait expires', async () => {
  state.account = true
  const { kill, exit } = await cli('logout')
  await until('TERM sent to the account pid', () => kill.mock.calls.some(([pid, signal]) => pid === 123456 && signal === 'SIGTERM'))
  await vi.runAllTimersAsync()
  expect(exit).toHaveBeenCalledWith(1)
  expect(exit).not.toHaveBeenCalledWith(0)
})
