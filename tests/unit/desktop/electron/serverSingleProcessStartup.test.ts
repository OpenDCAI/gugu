import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireHomeLock, assertAccountLogin, homeLockHolder, markServerReady, ownsHomeLock, readPendingVerify, writePendingVerify } from '../../../../apps/desktop/electron/server/server-startup'
import type { ServerAccount } from '../../../../apps/desktop/electron/server/server-layout'

let home: string
beforeEach(() => {
  vi.stubEnv('GUGU_TASK_HOST_VERSION', '2.0.0')
  vi.stubEnv('GUGU_SERVER_BOOT_ID', 'current-test-boot')
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-single-start-'))
  for (const version of ['1.0.0', '2.0.0']) fs.mkdirSync(path.join(home, 'versions', version), { recursive: true })
  fs.symlinkSync('versions/2.0.0', path.join(home, 'current'))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }) })
const account = (userId: string, signedIn = true): ServerAccount => ({ userId, signedIn, email: `${userId}@example.test`,
  addedAt: null, dir: '', dataDir: '', homeDir: '', signedOut: null })

describe('single-process server startup', () => {
  it('keeps the pending attempts untouched when another run holds the home lock', () => {
    writePendingVerify(home, { from: '1.0.0', to: '2.0.0', attempts: 0 })
    const release = acquireHomeLock(home, () => true)!
    expect(acquireHomeLock(home, () => true)).toBeNull()
    expect(readPendingVerify(home)?.attempts).toBe(0)
    release()
    expect(fs.existsSync(path.join(home, 'data/server.lock'))).toBe(false)
  })

  it('recovers a stale home lock using the existing PID file format', () => {
    fs.mkdirSync(path.join(home, 'data'))
    fs.writeFileSync(path.join(home, 'data/server.lock'), '999999')
    const release = acquireHomeLock(home, () => false)!
    expect(fs.readFileSync(path.join(home, 'data/server.lock'), 'utf8')).toBe(String(process.pid))
    release()
  })

  it('reclaims a live PID from another boot without changing the legacy numeric lock format', () => {
    fs.mkdirSync(path.join(home, 'data'))
    const lock = path.join(home, 'data/server.lock')
    fs.writeFileSync(lock, '12345')
    const inode = fs.statSync(lock)
    const proof = path.join(home, 'data', `.server-lock-${inode.dev}-${inode.ino}.json`)
    fs.writeFileSync(proof, JSON.stringify({ pid: 12345, bootId: 'previous-boot' }))
    expect(homeLockHolder(home, () => true)).toBeNull()
    const release = acquireHomeLock(home, () => true)
    expect(release).toBeTypeOf('function')
    expect(Number(fs.readFileSync(lock, 'utf8').trim())).toBe(process.pid)
    expect(fs.existsSync(proof)).toBe(false)
    release!()
    expect(fs.readdirSync(path.join(home, 'data')).filter(name => name.startsWith('.server-lock-'))).toEqual([])
  })

  it.each(['missing', 'wrong-pid', 'same-boot'])('preserves a live holder with %s boot evidence', mode => {
    const release = acquireHomeLock(home, () => true)!
    const data = path.join(home, 'data')
    const proof = fs.readdirSync(data).find(name => name.startsWith('.server-lock-'))
    expect(proof).toBeDefined()
    if (mode === 'missing') fs.rmSync(path.join(data, proof!))
    if (mode === 'wrong-pid') fs.writeFileSync(path.join(data, proof!), JSON.stringify({ pid: process.pid + 1, bootId: 'previous-boot' }))
    expect(homeLockHolder(home, () => true)).toBe(process.pid)
    expect(acquireHomeLock(home, () => true)).toBeNull()
    release()
  })

  it('publishes boot evidence before making the PID lock visible', () => {
    const link = fs.linkSync
    const publish = vi.spyOn(fs, 'linkSync').mockImplementation((candidate, target) => {
      const inode = fs.statSync(candidate)
      const proof = path.join(home, 'data', `.server-lock-${inode.dev}-${inode.ino}.json`)
      expect(JSON.parse(fs.readFileSync(proof, 'utf8'))).toMatchObject({ pid: process.pid })
      expect(Number(fs.readFileSync(candidate, 'utf8').trim())).toBe(process.pid)
      expect(fs.existsSync(target)).toBe(false)
      link(candidate, target)
    })
    const release = acquireHomeLock(home, () => true)!
    expect(publish).toHaveBeenCalledOnce()
    release()
  })

  it('clears pending verification on reaching a stable state and retains the request result', () => {
    writePendingVerify(home, { from: '1.0.0', to: '2.0.0', attempts: 0, request: 42 })
    markServerReady(home, 500)
    expect(readPendingVerify(home)).toBeNull()
    expect(JSON.parse(fs.readFileSync(path.join(home, 'data/server-update.json'), 'utf8')))
      .toMatchObject({ state: 'idle', version: '2.0.0', lastOutcome: { kind: 'switched', target: '2.0.0', request: 42 } })
  })

  it('cannot let the outgoing version claim readiness for a package it has not run', () => {
    writePendingVerify(home, { from: '1.0.0', to: '2.0.0', attempts: 0, request: 42 })
    process.env.GUGU_TASK_HOST_VERSION = '1.0.0'
    markServerReady(home, 500)
    expect(readPendingVerify(home)).toEqual({ from: '1.0.0', to: '2.0.0', attempts: 0, request: 42 })
    expect(fs.existsSync(path.join(home, 'data/server-update.json'))).toBe(false)
  })

  it.each(['EMFILE', 'EIO'])('does not treat a transient %s read as proof of losing the lock', code => {
    const release = acquireHomeLock(home)!
    const read = fs.readFileSync
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      if (String(file).endsWith('server.lock')) throw Object.assign(new Error(code), { code })
      return read(file, ...args)
    })
    expect(ownsHomeLock(home)).toBeUndefined()
    vi.restoreAllMocks()
    expect(ownsHomeLock(home)).toBe(true)
    release()
    expect(ownsHomeLock(home)).toBe(false)
  })

  it('retains malformed verification evidence and continues current without selecting or deleting a package', () => {
    fs.mkdirSync(path.join(home, 'data'))
    fs.writeFileSync(path.join(home, 'data/pending-verify.json'), '{broken')
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(readPendingVerify(home)).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('INVALID STARTUP VERIFICATION'))
    const evidence = fs.readdirSync(path.join(home, 'data')).find(name => name.startsWith('pending-verify.json.invalid-'))!
    expect(fs.readFileSync(path.join(home, 'data', evidence), 'utf8')).toBe('{broken')
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(path.join(home, 'versions/2.0.0'))
  })

  it('restores a fresh owner encountered while recovering a previously dead PID', () => {
    fs.mkdirSync(path.join(home, 'data'))
    const lock = path.join(home, 'data/server.lock')
    fs.writeFileSync(lock, '999999')
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === lock) fs.writeFileSync(lock, String(process.pid))
      rename(from, to)
    })
    expect(acquireHomeLock(home, () => false)).toBeNull()
    expect(fs.readFileSync(lock, 'utf8')).toBe(String(process.pid))
  })

  it('removes its own lock if writing its PID fails', () => {
    const write = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (typeof file === 'number') throw new Error('ENOSPC fixture')
      return write(file, ...args)
    })
    expect(() => acquireHomeLock(home)).toThrow('ENOSPC fixture')
    expect(fs.existsSync(path.join(home, 'data/server.lock'))).toBe(false)
  })

  it('allows the same account to renew login but refuses another identity', () => {
    expect(() => assertAccountLogin(account('one'), 'one')).not.toThrow()
    expect(() => assertAccountLogin(account('one'), 'two')).toThrow('one@example.test')
  })
})
