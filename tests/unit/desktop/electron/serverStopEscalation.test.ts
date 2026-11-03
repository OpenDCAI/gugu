import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ alive: true, home: '' }))
vi.mock('../../../../apps/desktop/electron/server/server-layout', async original => ({
  ...await original<typeof import('../../../../apps/desktop/electron/server/server-layout')>(),
  listAccounts: () => [], supervisorDataDir: () => path.join(state.home, 'data'),
}))
vi.mock('../../../../apps/desktop/electron/server/process-alive', async original => ({
  ...await original<typeof import('../../../../apps/desktop/electron/server/process-alive')>(),
  isProcessAlive: () => state.alive,
}))
vi.mock('../../../../apps/desktop/electron/server/server-electron-shim', () => ({ default: {} }))
const argv = process.argv
const loader = Module as unknown as { _load: unknown }
const originalLoad = loader._load

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
  await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(123456, 'SIGTERM'), { timeout: 10_000 })
  await vi.runAllTimersAsync()
  expect(kill).toHaveBeenCalledWith(123456, 'SIGTERM')
  expect(kill).toHaveBeenCalledWith(123456, 'SIGKILL')
  expect(stdout).toContain('KILL for pid 123456')
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
  expect(exit).not.toHaveBeenCalledWith(1)
})
