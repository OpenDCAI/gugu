import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readAccountRuntime } from '../../../../apps/desktop/electron/server/server-account-runtime'
import { accountLockHolder, processOwnsAccountLock } from '../../../../apps/desktop/electron/server/server-account-lock'

// These fixtures use this worker as an otherwise valid live server. Exercise
// real descriptor ownership after the process-marker check has passed.
vi.mock('../../../../apps/desktop/electron/server/process-alive', async (original) => {
  const actual = await original<typeof import('../../../../apps/desktop/electron/server/process-alive')>()
  return { ...actual, isOwnProcessAlive: actual.isProcessAlive }
})

const dirs: string[] = []
const fds: number[] = []
let release: (() => void) | undefined
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-account-lock-1447-'))
  dirs.push(dir)
  return dir
}
const hold = (dir: string, flags = 'wx') => {
  const file = path.join(dir, 'server.lock')
  if (flags === 'r') fs.writeFileSync(file, String(process.pid))
  const fd = fs.openSync(file, flags, 0o600)
  fds.push(fd)
  if (flags !== 'r') fs.writeSync(fd, String(process.pid))
  return file
}
afterEach(() => {
  release?.()
  release = undefined
  for (const fd of fds.splice(0)) fs.closeSync(fd)
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('does not report another account as running when its PID was reused', () => {
  const accountA = tmp(), accountB = tmp()
  hold(accountA)
  fs.writeFileSync(path.join(accountB, 'server.lock'), String(process.pid))
  expect(readAccountRuntime(accountB, { alive: () => true })).toEqual({ pid: null, version: null })
  expect(readAccountRuntime(accountA, { alive: () => true }).pid).toBe(process.pid)
})

it('does not trust the same PID holding an unlinked previous incarnation of the lock', () => {
  const dir = tmp()
  const file = hold(dir)
  fs.unlinkSync(file)
  fs.writeFileSync(file, String(process.pid))
  expect(readAccountRuntime(dir, { alive: () => true })).toEqual({ pid: null, version: null })
})

it('does not treat a status reader as the lock owner', () => {
  const dir = tmp()
  hold(dir, 'r')
  expect(readAccountRuntime(dir, { alive: () => true })).toEqual({ pid: null, version: null })
})

it('takes over a stale account lock without touching another live account or its engine ledger', async () => {
  const accountA = tmp(), accountB = tmp()
  const lockA = hold(accountA)
  fs.writeFileSync(path.join(accountA, 'engine-ledger.json'), 'preserve')
  fs.writeFileSync(path.join(accountB, 'server.lock'), String(process.pid))
  vi.stubEnv('GUGU_TASK_HOST_USER_DATA', accountB)
  vi.resetModules()
  const { app } = await import('../../../../apps/desktop/electron/server/server-electron-shim')
  release = () => app.releaseSingleInstanceLock()
  expect(app.requestSingleInstanceLock()).toBe(true)
  expect(app.requestSingleInstanceLock()).toBe(false)
  expect(fs.readFileSync(lockA, 'utf8')).toBe(String(process.pid))
  expect(fs.readFileSync(path.join(accountA, 'engine-ledger.json'), 'utf8')).toBe('preserve')
})

it('leaves a lock intact when its descriptors cannot be inspected', () => {
  const dir = tmp()
  const file = hold(dir)
  expect(() => accountLockHolder(dir, { alive: () => true, ownsLock: () => { throw new Error('permission denied') } })).toThrow('permission denied')
  expect(fs.readFileSync(file, 'utf8')).toBe(String(process.pid))
})

it('does not remove a replacement inode when an older owner releases its descriptor', async () => {
  const dir = tmp()
  vi.stubEnv('GUGU_TASK_HOST_USER_DATA', dir)
  vi.resetModules()
  const { app } = await import('../../../../apps/desktop/electron/server/server-electron-shim')
  release = () => app.releaseSingleInstanceLock()
  expect(app.requestSingleInstanceLock()).toBe(true)
  const file = path.join(dir, 'server.lock')
  fs.unlinkSync(file)
  fs.writeFileSync(file, 'replacement')
  app.releaseSingleInstanceLock()
  expect(fs.readFileSync(file, 'utf8')).toBe('replacement')
})

it.each(['0100001', '0100002'])('recognizes Linux writable inode ownership with flags %s', (flags) => {
  const dir = tmp()
  const file = hold(dir)
  const stat = fs.statSync(file, { bigint: true })
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' } }))
  const realStat = fs.statSync.bind(fs), realRead = fs.readFileSync.bind(fs)
  vi.spyOn(fs, 'readdirSync').mockReturnValue(['7'] as never)
  vi.spyOn(fs, 'statSync').mockImplementation(((target, options) => String(target).startsWith('/proc/') ? stat : realStat(target, options)) as typeof fs.statSync)
  vi.spyOn(fs, 'readFileSync').mockImplementation(((target, ...args) => String(target).startsWith('/proc/') ? `flags:\t${flags}\n` : realRead(target, ...args)) as typeof fs.readFileSync)
  expect(processOwnsAccountLock(process.pid, file)).toBe(true)
})

it('rejects a Linux read-only descriptor and a different inode', () => {
  const dir = tmp()
  const file = hold(dir)
  const stat = fs.statSync(file, { bigint: true })
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' } }))
  const realStat = fs.statSync.bind(fs), realRead = fs.readFileSync.bind(fs)
  vi.spyOn(fs, 'readdirSync').mockReturnValue(['7'] as never)
  const info = vi.spyOn(fs, 'statSync').mockImplementation(((target, options) => String(target).startsWith('/proc/') ? stat : realStat(target, options)) as typeof fs.statSync)
  vi.spyOn(fs, 'readFileSync').mockImplementation(((target, ...args) => String(target).startsWith('/proc/') ? 'flags:\t0100000\n' : realRead(target, ...args)) as typeof fs.readFileSync)
  expect(processOwnsAccountLock(process.pid, file)).toBe(false)
  info.mockImplementation(((target, options) => String(target).startsWith('/proc/') ? { ...stat, ino: stat.ino + 1n } : realStat(target, options)) as typeof fs.statSync)
  expect(processOwnsAccountLock(process.pid, file)).toBe(false)
})
