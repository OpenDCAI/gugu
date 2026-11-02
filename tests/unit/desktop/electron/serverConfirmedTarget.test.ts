import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccountDriver } from '../../../../apps/desktop/electron/server/server-account-driver'
import { INITIAL_ACCOUNT_STATE, readAccountState, writeAccountState } from '../../../../apps/desktop/electron/server/server-account-machine'
import { createServerVersionLifecycle } from '../../../../apps/desktop/electron/server/server-version-lifecycle'
import { recordDesktopReport, requestVersionSwitch, VERSION_SWITCH_FILE } from '../../../../packages/core/src/cloud/serverDesktopVersions'

let home: string
let clock: number
let running: boolean
const savedHome = process.env.GUGU_SERVER_HOME
const userId = '11111111-1111-4111-8111-111111111111'
const data = () => path.join(home, 'accounts', userId, 'data')
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-confirmed-target-'))
  process.env.GUGU_SERVER_HOME = home
  clock = 1_800_000_000_000
  running = true
  fs.mkdirSync(data(), { recursive: true })
  for (const version of ['0.9.0', '1.0.0', '2.0.0', '3.0.0']) {
    const bin = path.join(home, 'versions', version, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'gugu-server'), '')
  }
  writeAccountState(data(), { ...INITIAL_ACCOUNT_STATE, version: '1.0.0' }, clock)
  report('1.0.0')
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.GUGU_SERVER_HOME
  else process.env.GUGU_SERVER_HOME = savedHome
  fs.rmSync(home, { recursive: true, force: true })
})
const report = (version: string) => recordDesktopReport(data(), { id: 'desktop', version, protocol: 17 }, clock)
const confirm = (target: string) => requestVersionSwitch(data(), 'confirmed product action', ++clock, true, target)
function driver() {
  const layout = { home, versions: path.join(home, 'versions'), version: '1.0.0' }
  return createAccountDriver({ layout, followSupervisor: false,
    lifecycle: createServerVersionLifecycle({ layout, verifyBoot: async () => undefined }),
    log: { info: vi.fn(), warn: vi.fn() }, now: () => clock,
    child: () => running ? { pid: 42, startedAt: 1, restarting: false } : undefined,
    started: () => running, restart: vi.fn(),
  })
}
async function tick(subject: ReturnType<typeof driver>, rounds = 3) {
  const account = { userId, dir: path.dirname(data()), dataDir: data(), homeDir: path.join(path.dirname(data()), 'home'),
    email: null, addedAt: null, signedIn: true, signedOut: null }
  for (let i = 0; i < rounds; i++) {
    fs.writeFileSync(path.join(data(), 'activity.json'), JSON.stringify({ pid: 42, startedAt: 1, at: ++clock, busy: false }))
    subject.tick([account])
    await subject.settled()
  }
}

describe('confirmed account target lifecycle', () => {
  it('persists the confirmed target across supervisor restart, repeated same-version reports and report expiry', async () => {
    confirm('2.0.0')
    await tick(driver())
    expect(readAccountState(data())).toMatchObject({ version: '2.0.0', phase: { kind: 'running' } })
    expect(fs.existsSync(path.join(data(), VERSION_SWITCH_FILE))).toBe(false)
    const restored = driver()
    for (let i = 0; i < 4; i++) {
      clock += 60 * 60 * 1000
      report('1.0.0')
      await tick(restored)
      expect(readAccountState(data())).toMatchObject({ version: '2.0.0', phase: { kind: 'running' } })
    }
    clock += 8 * 24 * 60 * 60 * 1000
    await tick(restored)
    expect(readAccountState(data())).toMatchObject({ version: '2.0.0', phase: { kind: 'running' } })
  })

  it('ends the confirmation on an actual desktop version change, permitting a downgrade and later returning to the old baseline', async () => {
    confirm('2.0.0')
    const subject = driver()
    await tick(subject)
    report('0.9.0')
    running = false
    await tick(subject, 2)
    running = true
    await tick(subject, 1)
    expect(readAccountState(data())).toMatchObject({ version: '0.9.0', phase: { kind: 'running' } })
    report('1.0.0')
    running = false
    await tick(subject, 2)
    running = true
    await tick(subject, 1)
    expect(readAccountState(data())).toMatchObject({ version: '1.0.0', phase: { kind: 'running' } })
  })

  it('replaces the first confirmation with a second confirmed target', async () => {
    const subject = driver()
    confirm('2.0.0')
    await tick(subject)
    confirm('3.0.0')
    await tick(subject)
    clock += 60 * 60 * 1000
    report('1.0.0')
    await tick(driver())
    expect(readAccountState(data())).toMatchObject({ version: '3.0.0', phase: { kind: 'running' } })
  })
})
