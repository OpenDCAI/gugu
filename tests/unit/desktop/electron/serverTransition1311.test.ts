import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServerBootReporter, readServerBootProgress } from '../../../../packages/core/src/cloud/serverBootProgress'
import { parseServerTransition } from '../../../../packages/core/src/cloud/serverTransition'
import { requestVersionSwitch } from '../../../../packages/core/src/cloud/serverDesktopVersions'
import { createAccountDriver } from '../../../../apps/desktop/electron/server/server-account-driver'
import { INITIAL_ACCOUNT_STATE, readAccountState, writeAccountState } from '../../../../apps/desktop/electron/server/server-account-machine'
import { runUpdateStatus, updateSnapshot } from '../../../../apps/desktop/electron/server/update-status-cli'
import type { ServerAccount } from '../../../../apps/desktop/electron/server/server-layout'
import type { ServerVersionLifecycle } from '../../../../apps/desktop/electron/server/server-version-lifecycle'

const paths: string[] = []
const temp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-transition-')); paths.push(p); return p }
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const p of paths.splice(0)) fs.rmSync(p, { recursive: true, force: true }) })

describe('supervisor-owned restart state', () => {
  it('persists stop/spawn/migration/ready facts across driver and CLI restarts, rejecting the old child', async () => {
    const home = temp(); vi.stubEnv('GUGU_SERVER_HOME', home)
    const userId = '11111111-1111-4111-8111-111111111111'
    const dataDir = path.join(home, 'accounts', userId, 'data'); fs.mkdirSync(dataDir, { recursive: true })
    let now = Date.now()
    for (const version of ['0.3.0', '0.3.1']) { const dir = path.join(home, 'versions', version, 'bin'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'gugu-server'), '') }
    const account = { userId, dataDir, signedIn: true, signedOut: null, email: null } as ServerAccount
    writeAccountState(dataDir, { ...INITIAL_ACCOUNT_STATE, supervisor: '0.3.0', version: '0.3.0', child: 'running' }, now)
    let child = { pid: 21, startedAt: now - 1_000, restarting: false }
    const restart = vi.fn(() => { child.restarting = true })
    const options = { layout: { home, versions: path.join(home, 'versions'), version: '0.3.0' },
      lifecycle: { ready: () => true } as unknown as ServerVersionLifecycle, followSupervisor: false,
      log: { info: vi.fn(), warn: vi.fn() }, child: () => child, started: () => true, restart, now: () => now }
    let driver = createAccountDriver(options)
    requestVersionSwitch(dataDir, 'confirmed', now, true, '0.3.1')
    driver.tick([account])
    expect(restart).toHaveBeenCalledTimes(1)
    expect(updateSnapshot(account, now).transition).toMatchObject({ request: now, target: '0.3.1', phase: 'stopping' })
    now += 1_000; child = { pid: 22, startedAt: now, restarting: false }; driver.childStarted(userId, 22)
    const report = createServerBootReporter({ GUGU_SERVER_MODE: '1', GUGU_TASK_HOST_USER_DATA: dataDir, GUGU_TASK_HOST_VERSION: '0.3.1' }, { pid: 22, now: () => now })
    report({ done: 2, total: 3 }); driver.tick([account])
    expect(updateSnapshot(account, now).transition).toMatchObject({ phase: 'migrating', pid: 22, done: 2, total: 3 })
    expect(readServerBootProgress(dataDir, { ...child, pid: 21 }, '0.3.1', now)).toBeNull()
    expect(readServerBootProgress(dataDir, child, '0.3.0', now)).toBeNull()
    driver = createAccountDriver(options) // supervisor-memory loss does not lose the operation.
    expect(readAccountState(dataDir)?.transition?.phase).toBe('migrating')
    now += 1_000; report({ phase: 'ready', search: { state: 'running', done: 42, total: 100 } })
    fs.writeFileSync(path.join(dataDir, 'activity.json'), JSON.stringify({ ...child, at: now, busy: false }))
    driver.tick([account])
    expect(updateSnapshot(account, now).transition).toMatchObject({ phase: 'ready', search: { state: 'running', done: 42, total: 100 } })
    const lines: string[] = []
    expect(await runUpdateStatus(['--account', userId], [account], line => lines.push(line))).toBe(0)
    expect(lines[0]).toContain('"pid":22')
  })

  it('does not treat corrupt state as a successful empty status or accept stale/invalid progress', () => {
    const dataDir = temp(); const now = Date.now()
    fs.writeFileSync(path.join(dataDir, 'server-update.json'), '{broken')
    expect(() => updateSnapshot({ dataDir } as ServerAccount)).toThrow()
    expect(parseServerTransition({ request: now, at: now - 600_001, target: '0.3.1', phase: 'migrating' }, now)).toBeNull()
    expect(parseServerTransition({ request: now, at: now, target: '0.3.1', phase: 'invented' }, now)).toBeNull()
  })
})
