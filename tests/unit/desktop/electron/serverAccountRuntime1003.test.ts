import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readAccountRuntime, installedPackageVersion } from '../../../../apps/desktop/electron/server/server-account-runtime'
import { describeProcess } from '../../../../apps/desktop/electron/server/server-service'
import { formatStatusJson, parseStatusJson, statusAccounts } from '../../../../apps/desktop/electron/server/server-status'
import type { ServerAccount } from '../../../../apps/desktop/electron/server/server-layout'

const NOW = 1_800_000_000_000
const files = (values: Record<string, string>) => (file: string) => values[file] ?? null
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('actual account package identity', () => {
  it('reads the live process version rather than the installation or saved pin', () => {
    const read = files({ '/data/server.lock': '42', '/proc/42/environ': 'GUGU_TASK_HOST_VERSION=old-live\0', '/data/server-version.json': '{"version":"new-pin"}' })
    expect(readAccountRuntime('/data', { read, alive: () => true })).toEqual({ pid: 42, version: 'old-live' })
  })
  it('does not trust heartbeat or process metadata after that PID exited', () => {
    const read = files({ '/data/server.lock': '42', '/proc/42/environ': 'GUGU_TASK_HOST_VERSION=new\0' })
    expect(readAccountRuntime('/data', { read, alive: () => false })).toEqual({ pid: null, version: null })
  })
  it('only uses a fresh heartbeat bound to the same PID when /proc is unavailable', () => {
    for (const [pid, at, version] of [[42, NOW, 'actual'], [43, NOW, null], [42, NOW - 60_001, null]] as const) {
      const read = files({ '/data/server.lock': '42', '/data/activity.json': JSON.stringify({ pid, at, version: 'actual' }) })
      expect(readAccountRuntime('/data', { read, alive: () => true, now: () => NOW })).toEqual({ pid: 42, version })
    }
  })
  it('an active process with no verified version stays unknown', () => {
    expect(readAccountRuntime('/data', { read: files({ '/data/server.lock': '42' }), alive: () => true })).toEqual({ pid: 42, version: null })
  })
  it('records installed, supervisor, and account versions separately in status JSON', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-status-1003-'))
    dirs.push(home)
    fs.mkdirSync(path.join(home, 'versions', 'installed'), { recursive: true })
    fs.symlinkSync('versions/installed', path.join(home, 'current'))
    const account: ServerAccount = { userId: 'u1', email: null, addedAt: null, dir: '/a', dataDir: '/a/data', homeDir: '/a/home', signedIn: true, signedOut: null }
    const report = { version: 'cli', installedVersion: installedPackageVersion(home), supervisorVersion: 'supervisor', accounts: statusAccounts([account], () => true, () => 'account') }
    expect(parseStatusJson(formatStatusJson(report))).toEqual({ version: 'cli', installedVersion: 'installed', supervisorVersion: 'supervisor', accounts: [{ userId: 'u1', email: null, signedIn: true, running: true, version: 'account', signedOut: null }] })
  })
  it('identifies controlled-cloud supervision from the live supervisor environment', () => {
    expect(describeProcess(42, 'GUGU_CLOUD_COMPUTER=1\0GUGU_TASK_HOST_VERSION=actual\0', null)).toMatchObject({ version: 'actual', managedCloud: true })
    expect(describeProcess(42, null, null).managedCloud).not.toBe(true)
  })
})
