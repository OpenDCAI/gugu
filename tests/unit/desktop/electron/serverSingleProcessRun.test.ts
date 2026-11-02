import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runSingleServer } from '../../../../apps/desktop/electron/server/server-run'
import { readPendingVerify, writePendingVerify } from '../../../../apps/desktop/electron/server/server-startup'

vi.mock('../../../../apps/desktop/electron/server/server-service', () => ({ repairServiceDefinition: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/server/server-updater', () => ({ managedLayout: () => null }))

let home: string
const environment = { ...process.env }
const signals: EventEmitter = process
let signalHandlers: Record<'SIGINT' | 'SIGTERM' | 'exit', ReturnType<EventEmitter['listeners']>>
const id = '00000000-0000-4000-8000-000000000001'
function signIn(userId = id): void {
  const dir = path.join(home, 'accounts', userId)
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ email: `${userId}@example.test` }))
  fs.writeFileSync(path.join(dir, 'data/server-session.enc'), 'fixture')
}
beforeEach(() => {
  vi.useFakeTimers()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-single-run-'))
  process.env.GUGU_SERVER_HOME = home
  process.env.GUGU_SERVER_SUPERVISED = 'keeper'
  fs.mkdirSync(path.join(home, 'data'))
  fs.writeFileSync(path.join(home, 'data/server.lock'), String(process.pid))
  signalHandlers = { SIGINT: signals.listeners('SIGINT'), SIGTERM: signals.listeners('SIGTERM'), exit: signals.listeners('exit') }
  vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit ${code}`) })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => {
  for (const event of ['SIGINT', 'SIGTERM', 'exit'] as const) {
    for (const handler of signals.listeners(event)) if (!signalHandlers[event].includes(handler)) signals.removeListener(event, handler as (...args: unknown[]) => void)
  }
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks()
  process.env = { ...environment }
  fs.rmSync(home, { recursive: true, force: true })
})

describe('installation run enters the account body without a child process', () => {
  it('claims its preloaded home lock without counting again, then enters the only account in this PID', async () => {
    signIn()
    writePendingVerify(home, { from: '1.0.0', to: '2.0.0', attempts: 0 })
    const prepare = vi.fn(() => {
      expect(fs.readFileSync(path.join(home, 'data/server.lock'), 'utf8')).toBe(String(process.pid))
      expect(readPendingVerify(home)?.attempts).toBe(0)
    })
    const body = vi.fn(async (userId: string) => { expect(userId).toBe(id); expect(prepare).toHaveBeenCalledOnce() })
    await runSingleServer(prepare, body)
    expect(body).toHaveBeenCalledExactlyOnceWith(id)
  })

  it('a duplicate run leaves verification and the active keeper’s stop flag untouched', async () => {
    writePendingVerify(home, { from: '1.0.0', to: '2.0.0', attempts: 0 })
    fs.writeFileSync(path.join(home, 'data/server.lock'), '49213')
    const prepare = vi.fn(), body = vi.fn(async () => undefined)
    await expect(runSingleServer(prepare, body)).rejects.toThrow('exit 78')
    expect(prepare).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
    expect(readPendingVerify(home)?.attempts).toBe(0)
    expect(fs.existsSync(path.join(home, 'data/stopped'))).toBe(false)
  })

  it('marks waiting for login stable before entering the body after a real account appears', async () => {
    writePendingVerify(home, { from: '1.0.0', to: '2.0.0', attempts: 0, request: 12 })
    const body = vi.fn(async () => undefined)
    const running = runSingleServer(() => undefined, body)
    expect(readPendingVerify(home)).toBeNull()
    expect(body).not.toHaveBeenCalled()
    signIn()
    await vi.advanceTimersByTimeAsync(3_000)
    await running
    expect(body).toHaveBeenCalledExactlyOnceWith(id)
  })

  it('refuses residual multiple accounts without entering either body or deleting their data', async () => {
    signIn(); signIn('00000000-0000-4000-8000-000000000002')
    const body = vi.fn(async () => undefined)
    await expect(runSingleServer(() => undefined, body)).rejects.toThrow('exit 78')
    expect(body).not.toHaveBeenCalled()
    expect(fs.readdirSync(path.join(home, 'accounts'))).toHaveLength(2)
    expect(fs.existsSync(path.join(home, 'data/stopped'))).toBe(true)
  })
})
