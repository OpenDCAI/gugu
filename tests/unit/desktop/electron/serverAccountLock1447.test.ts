import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { readAccountRuntime } from '../../../../apps/desktop/electron/server/server-account-runtime'
import { accountLockHolder } from '../../../../apps/desktop/electron/server/server-account-lock'
import { AccountInstanceLock } from '../../../../apps/desktop/electron/server/server-account-instance-lock'
import { createAccountLockProbe } from '../../../../apps/desktop/electron/server/server-account-lock-probe.cjs'

const linuxProbe = createAccountLockProbe({ fs, spawnSync, platform: 'linux', kill: () => {} })

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

it.each(['', 'unpublished'])('does not steal a writable legacy lock before a valid PID is published: %j', (pidText) => {
  const dir = tmp(), file = path.join(dir, 'server.lock'), instance = new AccountInstanceLock()
  const fd = fs.openSync(file, 'wx'); fds.push(fd); fs.writeSync(fd, pidText)
  const inode = fs.fstatSync(fd, { bigint: true }).ino
  release = () => instance.release()
  expect(() => accountLockHolder(dir)).toThrow('Cannot verify account lock ownership')
  expect(() => instance.acquire(dir)).toThrow('Cannot verify account lock ownership')
  expect(fs.statSync(file, { bigint: true }).ino).toBe(inode)
  expect(fs.readFileSync(file, 'utf8')).toBe(pidText)
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
  const realStat = fs.statSync.bind(fs), realRead = fs.readFileSync.bind(fs)
  vi.spyOn(fs, 'readdirSync').mockReturnValue(['7'] as never)
  vi.spyOn(fs, 'statSync').mockImplementation(((target, options) => String(target).startsWith('/proc/') ? stat : realStat(target, options)) as typeof fs.statSync)
  vi.spyOn(fs, 'readFileSync').mockImplementation(((target, ...args) => String(target).startsWith('/proc/') ? `flags:\t${flags}\n` : realRead(target, ...args)) as typeof fs.readFileSync)
  expect(linuxProbe.owns(process.pid, file)).toBe(true)
})

it('rejects a Linux read-only descriptor and a different inode', () => {
  const dir = tmp()
  const file = hold(dir)
  const stat = fs.statSync(file, { bigint: true })
  const realStat = fs.statSync.bind(fs), realRead = fs.readFileSync.bind(fs)
  vi.spyOn(fs, 'readdirSync').mockReturnValue(['7'] as never)
  const info = vi.spyOn(fs, 'statSync').mockImplementation(((target, options) => String(target).startsWith('/proc/') ? stat : realStat(target, options)) as typeof fs.statSync)
  vi.spyOn(fs, 'readFileSync').mockImplementation(((target, ...args) => String(target).startsWith('/proc/') ? 'flags:\t0100000\n' : realRead(target, ...args)) as typeof fs.readFileSync)
  expect(linuxProbe.owns(process.pid, file)).toBe(false)
  info.mockImplementation(((target, options) => String(target).startsWith('/proc/') ? { ...stat, ino: stat.ino + 1n } : realStat(target, options)) as typeof fs.statSync)
  expect(linuxProbe.owns(process.pid, file)).toBe(false)
})

it.each([false, true])('does not infer Linux process death from a hidden procfs entry (exited=%s)', (exited) => {
  const dir = tmp(), file = hold(dir)
  const read = fs.readFileSync.bind(fs)
  vi.spyOn(fs, 'readFileSync').mockImplementation(((target, ...args) => {
    if (String(target) === `/proc/${process.pid}/stat`) throw Object.assign(new Error('hidden'), { code: 'ENOENT' })
    return read(target, ...args)
  }) as typeof fs.readFileSync)
  const kill = vi.fn().mockReturnValue(true)
  if (exited) kill.mockReturnValueOnce(true).mockImplementation(() => { throw Object.assign(new Error('exited'), { code: 'ESRCH' }) })
  const probe = createAccountLockProbe({ fs, spawnSync, platform: 'linux', kill })
  if (exited) expect(probe.holder(dir)).toBe(null)
  else expect(() => probe.holder(dir)).toThrow('Cannot verify account lock ownership')
  expect(kill).toHaveBeenCalledTimes(2)
  expect(fs.readFileSync(file, 'utf8')).toBe(String(process.pid))
})

it.each([
  { status: 1, stdout: '', stderr: '' },
  { status: 0, stdout: `p${process.pid}\nferr\na \nnFD info error: Operation not permitted\n`, stderr: '' },
])('rejects incomplete macOS inspection without treating it as stale: %j', (result) => {
  const dir = tmp(), file = hold(dir)
  const probe = createAccountLockProbe({ fs, platform: 'darwin', kill: () => {}, spawnSync: (() => result) as typeof spawnSync })
  expect(() => probe.holder(dir)).toThrow('Cannot verify account lock ownership')
  expect(fs.readFileSync(file, 'utf8')).toBe(String(process.pid))
})

it.each(['r', 'w', 'u'])('uses complete macOS FD enumeration with access %s', (access) => {
  const dir = tmp(), file = hold(dir)
  const stat = fs.statSync(file, { bigint: true })
  const inspect = vi.fn((..._args: Parameters<typeof spawnSync>) => ({ status: 0, stderr: '', stdout: `p${process.pid}\nf7\na${access}\ntREG\nD0x${stat.dev.toString(16)}\ni${stat.ino}\nn${file}\n` }))
  const probe = createAccountLockProbe({ fs, platform: 'darwin', kill: () => {}, spawnSync: inspect as unknown as typeof spawnSync })
  expect(probe.holder(dir)).toBe(access === 'r' ? null : process.pid)
  expect(inspect.mock.calls[0][1]).toEqual(['-nP', '-a', '-p', String(process.pid), '-F', 'faDitn'])
})

it('serializes stale-lock takeover before rename and releases the permanent guard', () => {
  const dir = tmp(), first = new AccountInstanceLock(), second = new AccountInstanceLock()
  fs.writeFileSync(path.join(dir, 'server.lock'), '2147483647')
  const rename = fs.renameSync.bind(fs)
  let contender: boolean | undefined
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    contender = second.acquire(dir)
    return rename(from, to)
  })
  release = () => { first.release(); second.release() }
  expect(first.acquire(dir)).toBe(true)
  expect(contender).toBe(false)
  const external = spawnSync(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    try { db.exec('BEGIN EXCLUSIVE'); console.log('acquired'); }
    catch (error) { if (error.errcode !== 5) throw error; console.log('busy'); }
    finally { db.close(); }
  `, path.join(dir, 'server-lock.sqlite')], { encoding: 'utf8' })
  expect(external.status).toBe(0)
  expect(external.stdout.trim()).toBe('busy')
  first.release()
  expect(second.acquire(dir)).toBe(true)
})

it('publishes a complete PID record atomically instead of exposing an empty new lock', () => {
  const dir = tmp(), instance = new AccountInstanceLock(), file = path.join(dir, 'server.lock')
  const link = fs.linkSync.bind(fs)
  const publish = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readFileSync(from, 'utf8')).toBe(String(process.pid))
    return link(from, to)
  })
  release = () => instance.release()
  expect(instance.acquire(dir)).toBe(true)
  expect(publish).toHaveBeenCalledTimes(1)
  expect(accountLockHolder(dir)).toBe(process.pid)
})

it('can prove a macOS PID is stale even when another regular filename contains error', () => {
  const dir = tmp(), file = hold(dir), stat = fs.statSync(file, { bigint: true })
  const inspect = () => ({ status: 0, stderr: '', stdout: `p${process.pid}\nf7\naw\ntREG\nD0x${stat.dev.toString(16)}\ni${stat.ino + 1n}\nn/var/log/error.log\n` })
  const probe = createAccountLockProbe({ fs, platform: 'darwin', kill: () => {}, spawnSync: inspect as typeof spawnSync })
  expect(probe.holder(dir)).toBe(null)
})

it('restores a legacy replacement that appeared before the atomic rename', () => {
  const dir = tmp(), owner = new AccountInstanceLock(), file = path.join(dir, 'server.lock')
  fs.writeFileSync(file, '2147483647')
  const rename = fs.renameSync.bind(fs)
  let replacement: bigint | undefined
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    fs.unlinkSync(file)
    hold(dir)
    replacement = fs.statSync(file, { bigint: true }).ino
    return rename(from, to)
  })
  release = () => owner.release()
  expect(owner.acquire(dir)).toBe(false)
  expect(fs.statSync(file, { bigint: true }).ino).toBe(replacement)
  expect(accountLockHolder(dir)).toBe(process.pid)
})
