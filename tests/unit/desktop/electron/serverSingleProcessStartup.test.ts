import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireHomeLock, assertAccountLogin, checkPendingBoot, EXIT_RESTART, markServerReady, onlySignedInAccount, readPendingVerify, writePendingVerify } from '../../../../apps/desktop/electron/server/server-startup'
import { readBadVersions } from '../../../../apps/desktop/electron/server/server-upgrade-guard'
import type { ServerAccount } from '../../../../apps/desktop/electron/server/server-layout'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-single-start-'))
  for (const version of ['1.0.0', '2.0.0']) fs.mkdirSync(path.join(home, 'versions', version), { recursive: true })
  fs.symlinkSync('versions/2.0.0', path.join(home, 'current'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))
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

  it('rolls back after exactly three launches failed to reach a stable state, irrespective of elapsed time', () => {
    writePendingVerify(home, { from: '1.0.0', to: '2.0.0', attempts: 0, request: 42 })
    for (const now of [100, 200_100, 9_000_000]) expect(checkPendingBoot(home, now)).toBeNull()
    expect(readPendingVerify(home)?.attempts).toBe(3)
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(path.join(home, 'versions/2.0.0'))
    expect(checkPendingBoot(home, 9_000_001)).toBe(EXIT_RESTART)
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(path.join(home, 'versions/1.0.0'))
    expect(readBadVersions(home)).toEqual({ '2.0.0': 9_000_001 })
    expect(readPendingVerify(home)).toBeNull()
    expect(JSON.parse(fs.readFileSync(path.join(home, 'data/server-update.json'), 'utf8')).lastOutcome)
      .toMatchObject({ kind: 'rolledBack', bad: '2.0.0', back: '1.0.0', request: 42 })
  })

  it('clears pending verification on reaching a stable state and retains the request result', () => {
    writePendingVerify(home, { from: '1.0.0', to: '2.0.0', attempts: 0, request: 42 })
    checkPendingBoot(home)
    markServerReady(home, 500)
    expect(readPendingVerify(home)).toBeNull()
    expect(JSON.parse(fs.readFileSync(path.join(home, 'data/server-update.json'), 'utf8')))
      .toMatchObject({ state: 'idle', version: '2.0.0', lastOutcome: { kind: 'switched', target: '2.0.0', request: 42 } })
    expect(checkPendingBoot(home, 100_000)).toBeNull()
  })

  it('rejects malformed verification records without selecting or deleting a package', () => {
    writePendingVerify(home, { from: '../other', to: '2.0.0', attempts: 0 })
    expect(() => checkPendingBoot(home)).toThrow('Invalid pending')
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(path.join(home, 'versions/2.0.0'))
  })

  it('waits with no signed-in account and accepts exactly one without deleting signed-out data', () => {
    expect(onlySignedInAccount([account('old', false)])).toBeNull()
    expect(onlySignedInAccount([account('old', false), account('one')])?.userId).toBe('one')
  })

  it('rejects residual multiple accounts with both names and a recovery instruction', () => {
    expect(() => onlySignedInAccount([account('one'), account('two')])).toThrow('one@example.test, two@example.test')
    expect(() => onlySignedInAccount([account('one'), account('two')])).toThrow('logout <email>')
  })

  it('allows the same account to renew login but refuses another identity', () => {
    expect(() => assertAccountLogin([account('one')], 'one')).not.toThrow()
    expect(() => assertAccountLogin([account('one')], 'two')).toThrow('one@example.test')
  })
})
