import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateAccountLayout, prepareAccountLogin } from '../../../../apps/desktop/electron/server/server-boot.cjs'

let home: string
const account = (name: string, signedIn = true, directory = path.join(home, 'accounts', name)) => {
  fs.mkdirSync(path.join(directory, 'data'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'account.json'), JSON.stringify({ userId: name, email: `${name}@example.test` }))
  fs.writeFileSync(path.join(directory, 'data/history'), `history-${name}`)
  if (signedIn) fs.writeFileSync(path.join(directory, 'data/server-session.enc'), 'session')
  return directory
}
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-account-migration-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }) })

describe('single account directory migration', () => {
  it('moves the whole account atomically, keeping installation state and rollback reads separate', () => {
    const source = account('one')
    const inode = fs.statSync(path.join(source, 'data/history')).ino
    fs.mkdirSync(path.join(home, 'data'))
    fs.writeFileSync(path.join(home, 'data/server.lock'), 'installation')
    fs.writeFileSync(path.join(source, 'data/server.lock'), 'account')
    migrateAccountLayout(home)
    expect(fs.readlinkSync(source)).toBe('../account')
    expect(fs.statSync(path.join(source, 'data/history')).ino).toBe(inode)
    expect(fs.statSync(path.join(home, 'account/data/history')).ino).toBe(inode)
    expect(fs.readFileSync(path.join(home, 'data/server.lock'), 'utf8')).toBe('installation')
    expect(fs.readFileSync(path.join(source, 'data/server.lock'), 'utf8')).toBe('account')
    migrateAccountLayout(home)
    expect(fs.readlinkSync(source)).toBe('../account')
  })

  it('rejects multiple signed-in directories without moving or editing their data', () => {
    const first = account('one'), second = account('two')
    const before = [first, second].map(dir => fs.statSync(dir).ino)
    expect(() => migrateAccountLayout(home)).toThrow(/one@example.test[\s\S]*mv -n[\s\S]*two@example.test/)
    expect([first, second].map(dir => fs.statSync(dir).ino)).toEqual(before)
    expect(fs.existsSync(path.join(home, 'account'))).toBe(false)
    expect(fs.existsSync(path.join(home, 'retired'))).toBe(false)
  })

  it('counts a fixed account and a real account created by a rolled-back version together', () => {
    account('one', true, path.join(home, 'account'))
    account('two')
    expect(() => migrateAccountLayout(home)).toThrow('More than one account')
    expect(fs.existsSync(path.join(home, 'accounts/two/data/history'))).toBe(true)
  })

  it('retires signed-out residual directories without deleting their history', () => {
    account('one'); account('old', false)
    migrateAccountLayout(home)
    expect(fs.readFileSync(path.join(home, 'retired/old/data/history'), 'utf8')).toBe('history-old')
    expect(fs.existsSync(path.join(home, 'accounts/old'))).toBe(false)
  })

  it('keeps a signed-out current account when no one is signed in', () => {
    account('one', false, path.join(home, 'account')); account('old', false)
    migrateAccountLayout(home)
    expect(fs.existsSync(path.join(home, 'account/data/history'))).toBe(true)
    expect(fs.readlinkSync(path.join(home, 'accounts/one'))).toBe('../account')
    expect(fs.existsSync(path.join(home, 'retired/old/data/history'))).toBe(true)
  })

  it('promotes the signed-in legacy directory after retiring a signed-out current account', () => {
    account('old', false, path.join(home, 'account')); account('one')
    migrateAccountLayout(home)
    expect(fs.readFileSync(path.join(home, 'account/data/history'), 'utf8')).toBe('history-one')
    expect(fs.existsSync(path.join(home, 'retired/old/data/history'))).toBe(true)
  })

  it('repairs an interrupted rename before alias publication on the next startup', () => {
    const source = account('one')
    fs.renameSync(source, path.join(home, 'account'))
    migrateAccountLayout(home)
    expect(fs.readlinkSync(source)).toBe('../account')
    expect(fs.readFileSync(path.join(source, 'data/history'), 'utf8')).toBe('history-one')
  })

  it('keeps the same account data readable through the old path after boot rollback', () => {
    const original = account('one')
    const inode = fs.statSync(path.join(original, 'data/history')).ino
    for (const version of ['1.0.0', '2.0.0']) fs.mkdirSync(path.join(home, 'versions', version), { recursive: true })
    fs.symlinkSync('versions/2.0.0', path.join(home, 'current'))
    fs.mkdirSync(path.join(home, 'data'))
    fs.writeFileSync(path.join(home, 'data/pending-verify.json'), JSON.stringify({ from: '1.0.0', to: '2.0.0', attempts: 3 }))
    const entry = path.join(home, 'entry.cjs')
    fs.writeFileSync(entry, "throw new Error('rolled back package must not load')")
    const result = spawnSync(process.execPath, ['--require', path.resolve('apps/desktop/electron/server/server-boot.cjs'), entry, 'run'], {
      env: { ...process.env, GUGU_SERVER_HOME: home, GUGU_TASK_HOST_VERSION: '2.0.0' }, encoding: 'utf8',
    })
    expect(result.status).toBe(75)
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(path.join(home, 'versions/1.0.0'))
    expect(fs.statSync(path.join(original, 'data/history')).ino).toBe(inode)
    expect(fs.readlinkSync(original)).toBe('../account')
  })

  it('never overwrites an existing retired account', () => {
    account('one'); const old = account('old', false)
    account('old', false, path.join(home, 'retired/old'))
    expect(() => migrateAccountLayout(home)).toThrow('Refusing to overwrite')
    expect(fs.lstatSync(old).isDirectory()).toBe(true)
    expect(fs.existsSync(path.join(home, 'account'))).toBe(false)
  })

  it('preserves the rename error and never falls back to running the legacy layout', () => {
    const original = account('one')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error(`EXDEV ${original}`), { code: 'EXDEV' }) })
    expect(() => migrateAccountLayout(home)).toThrow(`EXDEV ${original}`)
    expect(fs.lstatSync(original).isDirectory()).toBe(true)
  })

  it('restores each owner history across A logout, B login, B logout, A login', () => {
    account('one'); migrateAccountLayout(home)
    fs.unlinkSync(path.join(home, 'account/data/server-session.enc'))
    prepareAccountLogin(home, 'two')
    fs.mkdirSync(path.join(home, 'account/data'), { recursive: true })
    fs.writeFileSync(path.join(home, 'account/data/history'), 'history-two')
    expect(fs.existsSync(path.join(home, 'accounts/one'))).toBe(false)
    prepareAccountLogin(home, 'one')
    expect(fs.readFileSync(path.join(home, 'account/data/history'), 'utf8')).toBe('history-one')
    expect(fs.readFileSync(path.join(home, 'retired/two/data/history'), 'utf8')).toBe('history-two')
    expect(fs.readlinkSync(path.join(home, 'accounts/one'))).toBe('../account')
    expect(fs.existsSync(path.join(home, 'accounts/two'))).toBe(false)
  })

  it('rejects switching away from a signed-in owner', () => {
    account('one'); migrateAccountLayout(home)
    expect(() => prepareAccountLogin(home, 'two')).toThrow('one@example.test')
    expect(fs.readFileSync(path.join(home, 'account/data/history'), 'utf8')).toBe('history-one')
  })

  it('retains the directory identity when old signed-out metadata lacks a userId', () => {
    const previous = account('one', false)
    fs.writeFileSync(path.join(previous, 'account.json'), JSON.stringify({ email: 'one@example.test' }))
    migrateAccountLayout(home)
    prepareAccountLogin(home, 'one')
    expect(JSON.parse(fs.readFileSync(path.join(home, 'account/account.json'), 'utf8')).userId).toBe('one')
    expect(fs.readFileSync(path.join(home, 'account/data/history'), 'utf8')).toBe('history-one')
  })

  it('exits 78 before consuming a pending boot attempt when migration is ambiguous', () => {
    account('one'); account('two')
    fs.mkdirSync(path.join(home, 'data'))
    const pending = path.join(home, 'data/pending-verify.json')
    fs.writeFileSync(pending, JSON.stringify({ from: '1.0.0', to: '2.0.0', attempts: 0 }))
    const entry = path.join(home, 'entry.cjs')
    fs.writeFileSync(entry, "throw new Error('application must not load')")
    const result = spawnSync(process.execPath, ['--require', path.resolve('apps/desktop/electron/server/server-boot.cjs'), entry, 'run'], {
      env: { ...process.env, GUGU_SERVER_HOME: home, GUGU_TASK_HOST_VERSION: '2.0.0' }, encoding: 'utf8',
    })
    expect(result.status).toBe(78)
    expect(result.stderr).toContain('one@example.test')
    expect(JSON.parse(fs.readFileSync(pending, 'utf8')).attempts).toBe(0)
    expect(fs.existsSync(path.join(home, 'account'))).toBe(false)
  })
})
