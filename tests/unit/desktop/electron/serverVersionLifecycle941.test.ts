import { listAccounts } from '../../../../apps/desktop/electron/server/server-layout'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServerVersionLifecycle, pointCurrent, recordVerifiedSupervisorVersion, readUpgradeMarker } from '../../../../apps/desktop/electron/server/server-version-lifecycle'
import { readAccountVersionPin } from '../../../../apps/desktop/electron/server/server-account-versions'
import { requestVersionRetry, requestConfirmedVersionRestart, readVersionSwitchRequest, recordDesktopReport } from '../../../../packages/core/src/cloud/serverDesktopVersions'
import { createAccountVersionConverger } from '../../../../apps/desktop/electron/server/server-account-converge'

let home: string
const saved = process.env.GUGU_SERVER_HOME
const userId = '11111111-1111-4111-8111-111111111111'
const now = 1_800_000_000_000
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-version941-')))
  process.env.GUGU_SERVER_HOME = home
  for (const version of ['1.0.0', '2.0.0', '3.0.0', '4.0.0', '5.0.0']) {
    fs.mkdirSync(path.join(home, 'versions', version, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(home, 'versions', version, 'bin', 'gugu-server'), '')
  }
  pointCurrent(home, path.join(home, 'versions', '3.0.0'))
})
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); if (saved === undefined) delete process.env.GUGU_SERVER_HOME; else process.env.GUGU_SERVER_HOME = saved })
const layout = () => ({ home, versions: path.join(home, 'versions'), version: '3.0.0' })
const marker = () => ({ from: '2.0.0', to: '3.0.0', fromDir: path.join(home, 'versions', '2.0.0'), toDir: path.join(home, 'versions', '3.0.0'), switchedAt: now })

describe('one supervisor version lifecycle', () => {
  it('retains actual current, explicit previous, live processes and a staging lease; reclaims only unowned directories', async () => {
    recordVerifiedSupervisorVersion(home, marker())
    const lifecycle = createServerVersionLifecycle({ layout: layout(), running: () => ['1.0.0'] })
    let release!: () => void
    const staged = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const first = lifecycle.stage('4.0.0', staged)
    const second = lifecycle.stage('4.0.0', staged)
    expect(staged).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(lifecycle.reclaim()).toEqual(['5.0.0'])
    expect(fs.existsSync(path.join(home, 'versions', '4.0.0'))).toBe(true)
    release(); await Promise.all([first, second])
    expect(lifecycle.reclaim()).toEqual(['4.0.0'])
    expect(fs.readdirSync(path.join(home, 'versions')).sort()).toEqual(['1.0.0', '2.0.0', '3.0.0'])
  })
  it('does not guess a legacy previous version from directory numbers or mtimes', () => {
    expect(createServerVersionLifecycle({ layout: layout() }).reclaim()).toEqual([])
    expect(fs.readdirSync(path.join(home, 'versions'))).toHaveLength(5)
  })
  it('persists rollback before switching; the watchdog establishes the verified previous fact', () => {
    const lifecycle = createServerVersionLifecycle({ layout: layout() })
    const next = { from: '3.0.0', to: '4.0.0', fromDir: path.join(home, 'versions', '3.0.0'), toDir: path.join(home, 'versions', '4.0.0'), switchedAt: now }
    lifecycle.switchSupervisor(next, () => {
      expect(readUpgradeMarker(home)).toEqual(next)
      expect(fs.realpathSync(path.join(home, 'current'))).toBe(next.fromDir)
    })
    expect(fs.realpathSync(path.join(home, 'current'))).toBe(next.toDir)
    recordVerifiedSupervisorVersion(home, next)
    expect(readAccountVersionPin(path.join(home, 'data'))).toMatchObject({ version: '4.0.0', previous: '3.0.0' })
  })
  it('Retry waits while busy; explicit target-bound confirmation interrupts exactly once and cannot authorise a later target', () => {
    const data = path.join(home, 'accounts', userId, 'data')
    fs.mkdirSync(data, { recursive: true })
    fs.writeFileSync(path.join(data, 'server-session.enc'), 'fixture')
    recordDesktopReport(data, { id: 'desktop', version: '4.0.0', protocol: 15 }, now)
    const env = { GUGU_SERVER_MODE: '1', GUGU_TASK_HOST_USER_DATA: data }
    const restart = vi.fn()
    let running = '3.0.0'
    const lifecycle = createServerVersionLifecycle({ layout: layout() })
    const converger = createAccountVersionConverger({ layout: layout(), lifecycle, log: { info: vi.fn(), warn: vi.fn() }, running: () => running, restart, busy: () => true, now: () => now })
    const accounts = listAccounts()
    expect(requestVersionRetry(env, now)).toBe(true)
    expect(readVersionSwitchRequest(data, now)?.confirmed).toBe(false)
    converger.converge(accounts)
    expect(restart).not.toHaveBeenCalled()
    expect(requestConfirmedVersionRestart(env, '4.0.0', false, now)).toBe(false)
    expect(requestConfirmedVersionRestart(env, '4.0.0', true, now)).toBe(true)
    converger.converge(accounts)
    expect(restart).toHaveBeenCalledOnce()
    expect(readVersionSwitchRequest(data, now)).toBeNull()
    running = '4.0.0'; converger.converge(accounts)
    recordDesktopReport(data, { id: 'desktop', version: '5.0.0', protocol: 15 }, now)
    converger.converge(accounts)
    expect(restart).toHaveBeenCalledOnce()
  })
})
