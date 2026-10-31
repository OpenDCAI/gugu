import { createServerVersionLifecycle } from '../../../../apps/desktop/electron/server/server-version-lifecycle'
/*
 * #6264「server 和桌面版本不匹配时，当场换成匹配的版本，升降都算」(product spec 第 5 条例外,owner 2026-09-25):
 *  · 不同账号共用一台机器:各跑和自己桌面匹配的那一份,换版只重启那一个账号;
 *  · 同一账号两台桌面版本不同:按新的那一边跑(选 A);
 *  · 降级:桌面比装着的旧 ⇒ 装旧版并只切这个账号;
 *  · 换版装东西的只有那台机器上的守护进程:桌面经 SSH 只报版本、请它换、上不了网时传字节(❌ 再装一份);
 *  · 超出兼容窗口:旧桌面那一侧显示「请更新这台电脑上的咕咕」(不去降同账号更新桌面在用的那一版);
 *  · 清理:在用的 + 最近 5 份。
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compareServerVersions,
  desktopProtocolOutsideWindow,
  DESKTOP_REPORT_REFRESH_MS,
  DESKTOP_REPORT_TTL_MS,
  noteDesktopHello,
  parseDesktopHello,
  pickTargetVersion,
  readDesktopReports,
  readVersionSwitchRequest,
  recordDesktopReport,
  reportedDesktopVersion,
  requestVersionRetry,
  requestVersionSwitch,
  VERSION_SWITCH_FILE,
} from '../../../../packages/core/src/cloud/serverDesktopVersions'
import { parseServerUpdateState } from '../../../../packages/core/src/cloud/deviceHostInfo'
import { normalizeDeviceCapabilities } from '../../../../packages/core/src/cloud/devices'
import { DownloadSiteUnreachableError, fetchVersionManifest, VersionNotPublishedError } from '../../../../apps/desktop/electron/server/server-updater'
import { MIN_CLIENT_PROTOCOL, REMOTE_PROTOCOL_VERSION } from '../../../../packages/core/src/cloud/serverMachineHealth'
import {
  pinnedVersionToRun,
  planAccountVersion,
  pruneVersions,
  readAccountVersionPin,
  versionsToKeep,
  writeAccountVersionPin,
} from '../../../../apps/desktop/electron/server/server-account-versions'
import {
  createAccountVersionConverger,
  VERSION_FAILURE_COOLDOWN_MS,
  VERSION_NOT_PUBLISHED_MAX_RETRY_MS,
  VERSION_NOT_PUBLISHED_RETRY_MS,
  notPublishedRetryMs,
} from '../../../../apps/desktop/electron/server/server-account-converge'
import { listAccounts } from '../../../../apps/desktop/electron/server/server-layout'
import { readBadVersions } from '../../../../apps/desktop/electron/server/server-upgrade-guard'
import { parseMatchArgs, runMatchVersion } from '../../../../apps/desktop/electron/server/match-version-cli'
import { InstallRun, runSshInstall, type SpawnSsh, type SshInstallDeps } from '../../../../apps/desktop/electron/server/ssh-install/runner'
import { createSshAutoUpgrader } from '../../../../apps/desktop/electron/server/ssh-install/auto-upgrade'
import { PROBE_BEGIN, PROBE_END } from '../../../../apps/desktop/electron/server/ssh-install/logic'
import type { SshUpgradeEvent } from '../../../../apps/desktop/src/lib/sshLink'

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const NOW = 1_800_000_000_000
const quietLog = { info: () => undefined, warn: () => undefined }

let home = ''
const previousHome = process.env.GUGU_SERVER_HOME

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-match-'))
  process.env.GUGU_SERVER_HOME = home
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.GUGU_SERVER_HOME
  else process.env.GUGU_SERVER_HOME = previousHome
})

const dataDir = (userId: string) => path.join(home, 'accounts', userId, 'data')
function signIn(userId: string): void {
  fs.mkdirSync(dataDir(userId), { recursive: true })
  fs.writeFileSync(path.join(dataDir(userId), 'server-session.enc'), 'x')
}
function installVersion(version: string, mtimeMs = NOW): void {
  const bin = path.join(home, 'versions', version, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'gugu-server'), '#!/bin/sh\n')
  fs.utimesSync(path.join(home, 'versions', version), mtimeMs / 1000, mtimeMs / 1000)
}
const report = (userId: string, id: string, version: string, protocol: number | null = REMOTE_PROTOCOL_VERSION, at = NOW) =>
  recordDesktopReport(dataDir(userId), { id, version, protocol }, at)

describe('目标版本:用这台机器的桌面里最新的那一台', () => {
  it('同一账号两台桌面版本不同 ⇒ 取新的(选 A);报告过期不算', () => {
    const reports = {
      mbp: { version: '0.2.160', protocol: 2, at: NOW },
      office: { version: '0.2.158', protocol: 2, at: NOW },
      oldLaptop: { version: '0.2.170', protocol: 2, at: NOW - DESKTOP_REPORT_TTL_MS - 1 },
    }
    expect(pickTargetVersion(reports, NOW)).toBe('0.2.160')
    expect(pickTargetVersion({}, NOW)).toBeNull()
    // 下载站上没有的那一版让位给次新的。
    expect(pickTargetVersion(reports, NOW, undefined, (v) => v === '0.2.160')).not.toBe('0.2.160')
  })

  it('版本号逐段比,正式版比同号的预发版新', () => {
    expect(compareServerVersions('0.2.50', '0.2.49')).toBeGreaterThan(0)
    expect(compareServerVersions('0.3.0', '0.2.999')).toBeGreaterThan(0)
    expect(compareServerVersions('0.3.0', '0.3.0-beta.9')).toBeGreaterThan(0)
    expect(compareServerVersions('0.3.0-beta.10', '0.3.0-beta.9')).toBeGreaterThan(0)
    // 守护进程自升级也用这把尺(server-updater.ts):以前只比主版本,ThinkPad 停在 46.1 时看不见 48.1。
    expect(compareServerVersions('0.2.51-beta.48.1', '0.2.51-beta.46.1')).toBeGreaterThan(0)
    expect(compareServerVersions('0.2.160', '0.2.160')).toBe(0)
  })

  it('账号跑钉住的那一版:钉了、不是守护进程那一版、装在盘上;否则跟着守护进程(converge 与升级看门狗同一条)', () => {
    const pin = (version: string) => ({ version, previous: null, at: 0 })
    const installed = (version: string) => version !== '0.2.137'
    expect(pinnedVersionToRun(pin('0.2.138'), '0.2.140', installed)).toBe('0.2.138')
    expect(pinnedVersionToRun(null, '0.2.140', installed)).toBeNull()
    expect(pinnedVersionToRun(pin('0.2.140'), '0.2.140', installed)).toBeNull()
    expect(pinnedVersionToRun(pin('0.2.137'), '0.2.140', installed)).toBeNull()
  })

  it('兼容窗口 = [MIN_CLIENT_PROTOCOL, REMOTE_PROTOCOL_VERSION];不报协议的老桌面不下结论', () => {
    expect(desktopProtocolOutsideWindow(REMOTE_PROTOCOL_VERSION)).toBe(false)
    expect(desktopProtocolOutsideWindow(MIN_CLIENT_PROTOCOL)).toBe(false)
    expect(desktopProtocolOutsideWindow(REMOTE_PROTOCOL_VERSION + 1)).toBe(true)
    expect(desktopProtocolOutsideWindow(MIN_CLIENT_PROTOCOL - 1)).toBe(true)
    expect(desktopProtocolOutsideWindow(null)).toBe(false)
  })

  it('桌面开窗口报的那一段:形状不对就不收', () => {
    expect(parseDesktopHello({ id: 'dev-1', version: '0.2.160', protocol: 2 })).toEqual({ id: 'dev-1', version: '0.2.160', protocol: 2 })
    expect(parseDesktopHello({ id: 'dev 1', version: '0.2.160' })).toBeNull()
    expect(parseDesktopHello({ id: 'dev-1', version: '../x' })).toBeNull()
    expect(parseDesktopHello({ id: 'dev-1', version: '0.2.160', protocol: 'x' })).toEqual({ id: 'dev-1', version: '0.2.160', protocol: null })
  })

  it('账号进程收到报告:记下;协议在窗口外 = 版本信号,留「当场换」请求;桌面自己什么也不记', () => {
    const env = { GUGU_SERVER_MODE: '1', GUGU_TASK_HOST_USER_DATA: dataDir(U1) }
    expect(noteDesktopHello(env, { id: 'mbp', version: '0.2.160', protocol: REMOTE_PROTOCOL_VERSION }, NOW)).toEqual({ recorded: true, switchRequested: false })
    expect(readVersionSwitchRequest(dataDir(U1), NOW)).toBeNull()
    expect(noteDesktopHello(env, { id: 'next', version: '0.3.0', protocol: REMOTE_PROTOCOL_VERSION + 1 }, NOW)).toEqual({ recorded: true, switchRequested: true })
    expect(readVersionSwitchRequest(dataDir(U1), NOW)).not.toBeNull()
    expect(Object.keys(readDesktopReports(dataDir(U1))).sort()).toEqual(['mbp', 'next'])
    expect(noteDesktopHello({ GUGU_TASK_HOST_USER_DATA: dataDir(U2) }, { id: 'x', version: '0.2.1', protocol: 2 }, NOW).recorded).toBe(false)
  })

  it('记着的已是同一件事(同一版、同一协议、还没到续报的时候):不写、不再留换版请求;变了才写', () => {
    const env = { GUGU_SERVER_MODE: '1', GUGU_TASK_HOST_USER_DATA: dataDir(U1) }
    // 窗口下沿之外的老桌面(窗口可以不止一格宽,❌ 拿「当前协议减一」当窗口外)。
    const old = { id: 'old', version: '0.2.51', protocol: MIN_CLIENT_PROTOCOL - 1 }
    expect(noteDesktopHello(env, old, NOW)).toEqual({ recorded: true, switchRequested: true })
    fs.rmSync(path.join(dataDir(U1), VERSION_SWITCH_FILE))
    expect(noteDesktopHello(env, old, NOW + 6_000)).toEqual({ recorded: true, switchRequested: false })
    expect(readDesktopReports(dataDir(U1)).old!.at).toBe(NOW)
    expect(readVersionSwitchRequest(dataDir(U1), NOW + 6_000)).toBeNull()
    // 报的协议变了 = 新的事实,当场写。
    expect(noteDesktopHello(env, { ...old, protocol: REMOTE_PROTOCOL_VERSION }, NOW + 7_000).recorded).toBe(true)
    expect(readDesktopReports(dataDir(U1)).old).toMatchObject({ protocol: REMOTE_PROTOCOL_VERSION, at: NOW + 7_000 })
    // 同一件事过了续报的时候:照开着的窗口那样续一次,报告才不会过期。
    noteDesktopHello(env, { ...old, protocol: REMOTE_PROTOCOL_VERSION }, NOW + 7_000 + DESKTOP_REPORT_REFRESH_MS)
    expect(readDesktopReports(dataDir(U1)).old!.at).toBe(NOW + 7_000 + DESKTOP_REPORT_REFRESH_MS)
  })
})

describe('planAccountVersion', () => {
  const base = { now: NOW, switchRequested: false, installed: () => true, busy: false, failed: () => false }
  it('已经是目标 / 没有报告:什么也不做', () => {
    expect(planAccountVersion({ ...base, reports: {}, running: '0.2.1' }).kind).toBe('none')
    expect(planAccountVersion({ ...base, reports: { a: { version: '0.2.1', protocol: 2, at: NOW } }, running: '0.2.1' }).kind).toBe('none')
  })
  it('没装先装;装好了有版本信号当场换,没有就等空闲;有 agent 在跑时版本信号也等空闲,只有人点的「现在重启更新」当场换', () => {
    const reports = { a: { version: '0.2.9', protocol: 2, at: NOW } }
    expect(planAccountVersion({ ...base, reports, running: '0.3.0', installed: () => false })).toEqual({ kind: 'stage', version: '0.2.9' })
    expect(planAccountVersion({ ...base, reports, running: '0.3.0', busy: true })).toEqual({ kind: 'wait-idle', version: '0.2.9' })
    // 10-28 Linux 2:桌面升了一版来敲门(版本信号),7 条车道正在跑的那一轮全断 —— 有 agent 在跑就等。
    expect(planAccountVersion({ ...base, reports, running: '0.3.0', busy: true, switchRequested: true })).toEqual({ kind: 'wait-idle', version: '0.2.9' })
    expect(planAccountVersion({ ...base, reports, running: '0.3.0', busy: true, switchRequested: true, switchConfirmed: true })).toEqual({ kind: 'switch', version: '0.2.9', urgent: true })
    expect(planAccountVersion({ ...base, reports, running: '0.3.0', switchRequested: true })).toEqual({ kind: 'switch', version: '0.2.9', urgent: false })
    expect(planAccountVersion({ ...base, reports, running: '0.3.0' })).toEqual({ kind: 'switch', version: '0.2.9', urgent: false })
  })
  it('这一版刚失败过:不再自己下、不再等空闲换;换版请求也不绕过冷却(能否解除由 failed 判)', () => {
    const reports = { a: { version: '0.2.9', protocol: 2, at: NOW } }
    expect(planAccountVersion({ ...base, reports, running: '0.3.0', installed: () => false, failed: () => true })).toEqual({ kind: 'failed', version: '0.2.9' })
    expect(planAccountVersion({ ...base, reports, running: '0.3.0', failed: () => true })).toEqual({ kind: 'failed', version: '0.2.9' })
    expect(planAccountVersion({ ...base, reports, running: '0.3.0', failed: () => true, switchRequested: true })).toEqual({ kind: 'failed', version: '0.2.9' })
    expect(planAccountVersion({ ...base, reports, running: '0.3.0', failed: () => false, switchRequested: true }).kind).toBe('switch')
  })
  it('目标版本下载站上没有:退回次新的那一版;一版都不剩就跟守护进程', () => {
    const reports = { a: { version: '0.2.9', protocol: 2, at: NOW }, b: { version: '0.3.1', protocol: 2, at: NOW } }
    const unpublished = (v: string) => v === '0.3.1'
    expect(planAccountVersion({ ...base, reports, running: '0.3.0', installed: () => false })).toEqual({ kind: 'stage', version: '0.3.1' })
    expect(planAccountVersion({ ...base, reports, running: '0.3.0', unpublished })).toEqual({ kind: 'switch', version: '0.2.9', urgent: false })
    expect(planAccountVersion({ ...base, reports: { b: reports.b }, running: '0.3.0', fallback: '0.3.0', unpublished }).kind).toBe('none')
  })
  it('再看的间隔:5 分钟起,每次翻倍,最多 6 小时', () => {
    expect([1, 2, 3, 4].map(notPublishedRetryMs)).toEqual([5, 10, 20, 40].map((m) => m * 60_000))
    expect(notPublishedRetryMs(100)).toBe(VERSION_NOT_PUBLISHED_MAX_RETRY_MS)
  })
})

// These planning fixtures represent packages whose cold boot was already verified.
// The real staging/boot admission is exercised by serverLiveActivity1013.test.ts.
async function verifiedLifecycle() {
  const lifecycle = createServerVersionLifecycle({
    layout: { home, versions: path.join(home, 'versions'), version: '0.3.0' },
    verifyBoot: async () => {},
  })
  for (const version of fs.readdirSync(path.join(home, 'versions'))) {
    if (fs.existsSync(path.join(home, 'versions', version, 'bin', 'gugu-server'))) await lifecycle.stage(version, async () => {})
  }
  return lifecycle
}

describe('守护进程:各账号各跑各的版本,换版只重启那一个账号', () => {
  async function converger(running: Map<string, string | null>, options: { stage?: (v: string) => Promise<void>; busy?: boolean } = {}) {
    const restarted: string[] = []
    const staged: string[] = []
    const c = createAccountVersionConverger({
      lifecycle: await verifiedLifecycle(),
      layout: { home, versions: path.join(home, 'versions'), version: '0.3.0' },
      log: quietLog,
      running: (userId) => (running.has(userId) ? running.get(userId) ?? null : undefined),
      restart: (userId) => restarted.push(userId),
      now: () => NOW,
      busy: () => options.busy ?? false,
      stage: async (v) => {
        staged.push(v)
        await (options.stage ?? (async (version: string) => installVersion(version)))(v)
      },
    })
    return { c, restarted, staged }
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('两个账号各报各的桌面版本 ⇒ 各自记下、各自从自己那一版起;只重启版本变了的那个', async () => {
    signIn(U1)
    signIn(U2)
    for (const v of ['0.3.0', '0.2.9', '0.3.1']) installVersion(v)
    report(U1, 'alice-mbp', '0.2.9')
    report(U2, 'bob-mbp', '0.3.0')
    const running = new Map<string, string | null>([[U1, '0.3.0'], [U2, '0.3.0']])
    const { c, restarted } = await converger(running)
    c.converge(listAccounts())
    expect(restarted).toEqual([U1])
    expect(readAccountVersionPin(dataDir(U1))?.version).toBe('0.2.9')
    expect(readAccountVersionPin(dataDir(U2))).toBeNull()
    expect(c.binaryFor(U1)).toEqual({ binary: path.join(home, 'versions', '0.2.9', 'bin', 'gugu-server'), version: '0.2.9' })
    // 守护进程自己这一版:照旧用自己的入口起。
    expect(c.binaryFor(U2)).toBeNull()
    // bob 的桌面升到 0.3.1:只动 bob。
    running.set(U1, '0.2.9')
    report(U2, 'bob-mbp', '0.3.1')
    c.converge(listAccounts())
    expect(restarted).toEqual([U1, U2])
    expect(readAccountVersionPin(dataDir(U2))?.version).toBe('0.3.1')
  })

  it('同一账号两台桌面:按新的那一边跑,旧桌面换回来 ❌ 来回重启', async () => {
    signIn(U1)
    for (const v of ['0.3.0', '0.3.1']) installVersion(v)
    report(U1, 'home', '0.3.1')
    report(U1, 'office', '0.3.0')
    const running = new Map<string, string | null>([[U1, '0.3.0']])
    const { c, restarted } = await converger(running)
    c.converge(listAccounts())
    expect(readAccountVersionPin(dataDir(U1))?.version).toBe('0.3.1')
    running.set(U1, '0.3.1')
    report(U1, 'office', '0.3.0')
    c.converge(listAccounts())
    expect(restarted).toEqual([U1])
  })

  it('降级:桌面比装着的旧 ⇒ 装旧版(后台下载)、有版本信号就当场只切这个账号(有 agent 在跑时要人点过「现在重启更新」)', async () => {
    signIn(U1)
    signIn(U2)
    installVersion('0.3.0')
    report(U1, 'alice-old', '0.2.9', MIN_CLIENT_PROTOCOL)
    fs.writeFileSync(path.join(dataDir(U1), 'version-switch.json'), JSON.stringify({ reason: 'test', at: NOW, confirmed: true, target: '0.2.9' }))
    const running = new Map<string, string | null>([[U1, '0.3.0'], [U2, '0.3.0']])
    const { c, restarted, staged } = await converger(running, { busy: true })
    c.converge(listAccounts())
    expect(staged).toEqual(['0.2.9'])
    expect(restarted).toEqual([])
    // 下载中:设备行上说「正在下载」(随这个账号的心跳报)。
    expect(JSON.parse(fs.readFileSync(path.join(dataDir(U1), 'server-update.json'), 'utf8'))).toMatchObject({ state: 'downloading', version: '0.2.9' })
    await flush()
    c.converge(listAccounts())
    expect(restarted).toEqual([U1])
    expect(readAccountVersionPin(dataDir(U1))).toMatchObject({ version: '0.2.9', previous: '0.3.0' })
    expect(fs.existsSync(path.join(dataDir(U1), 'version-switch.json'))).toBe(false)
  })

  it('版本信号来了、账号在干活:不结束账号进程,等空闲(设备行说「空闲时自动更新」);人点「现在重启更新」才当场换', async () => {
    signIn(U1)
    for (const v of ['0.3.0', '0.3.1']) installVersion(v)
    report(U1, 'mbp', '0.3.1')
    fs.writeFileSync(path.join(dataDir(U1), 'version-switch.json'), JSON.stringify({ reason: 'desktop speaks protocol 13', at: NOW }))
    const { c, restarted } = await converger(new Map([[U1, '0.3.0']]), { busy: true })
    c.converge(listAccounts())
    expect(restarted).toEqual([])
    expect(JSON.parse(fs.readFileSync(path.join(dataDir(U1), 'server-update.json'), 'utf8'))).toMatchObject({ state: 'ready', version: '0.3.1' })
    expect(fs.existsSync(path.join(dataDir(U1), 'version-switch.json'))).toBe(true)
    fs.writeFileSync(path.join(dataDir(U1), 'version-switch.json'), JSON.stringify({ reason: 'confirmed restart from desktop', at: NOW, confirmed: true, target: '0.3.1' }))
    c.converge(listAccounts())
    expect(restarted).toEqual([U1])
  })

  it('人点的「现在重启更新」10 分钟内算数,过了只是普通的版本信号', () => {
    signIn(U1)
    fs.writeFileSync(path.join(dataDir(U1), 'version-switch.json'), JSON.stringify({ reason: 'confirmed restart from desktop', at: NOW, confirmed: true, target: '0.3.1' }))
    expect(readVersionSwitchRequest(dataDir(U1), NOW + 60_000)).toMatchObject({ confirmed: true })
    expect(readVersionSwitchRequest(dataDir(U1), NOW + 11 * 60_000)).toMatchObject({ confirmed: false })
  })

  it('没有版本信号、账号在干活:装好了也等空闲(设备行说「空闲时自动更新」)', async () => {
    signIn(U1)
    for (const v of ['0.3.0', '0.3.1']) installVersion(v)
    report(U1, 'mbp', '0.3.1')
    const { c, restarted } = await converger(new Map([[U1, '0.3.0']]), { busy: true })
    c.converge(listAccounts())
    expect(restarted).toEqual([])
    expect(JSON.parse(fs.readFileSync(path.join(dataDir(U1), 'server-update.json'), 'utf8'))).toMatchObject({ state: 'ready', version: '0.3.1' })
  })

  it('装不上(下载 / 校验 / 试跑失败):冷却 ❌ 每 3 秒重下一遍;设备行报「更新没成功」;人点「重试」(更晚的换版请求)再试一次', async () => {
    signIn(U1)
    installVersion('0.3.0')
    report(U1, 'dev', '0.2.1-dev')
    let t = NOW
    const staged: string[] = []
    const c = createAccountVersionConverger({
      lifecycle: await verifiedLifecycle(),
      layout: { home, versions: path.join(home, 'versions'), version: '0.3.0' },
      log: quietLog,
      running: () => '0.3.0',
      restart: () => undefined,
      now: () => t,
      busy: () => false,
      stage: async (v) => {
        staged.push(v)
        throw new Error('下载失败(500)')
      },
    })
    const update = () => JSON.parse(fs.readFileSync(path.join(dataDir(U1), 'server-update.json'), 'utf8'))
    c.converge(listAccounts())
    await flush()
    c.converge(listAccounts())
    expect(staged).toEqual(['0.2.1-dev'])
    expect(update()).toMatchObject({ state: 'failed', version: '0.2.1-dev' })
    // 「重试」:设备 RPC → 账号进程留一个比失败更晚的请求。
    t += 1000
    expect(requestVersionRetry({ GUGU_SERVER_MODE: '1', GUGU_TASK_HOST_USER_DATA: dataDir(U1) }, t)).toBe(true)
    c.converge(listAccounts())
    expect(staged).toEqual(['0.2.1-dev', '0.2.1-dev'])
    expect(update()).toMatchObject({ state: 'downloading', version: '0.2.1-dev' })
    await flush()
    expect(update()).toMatchObject({ state: 'failed' })
  })

  it('装上了、试跑账号起不来:记成「起不来」(reason=boot-failed);普通重试 ❌ 解除,只有绑定这一版的确认重启才再试', async () => {
    signIn(U1)
    installVersion('0.3.0')
    report(U1, 'mbp', '0.3.1')
    let t = NOW
    const staged: string[] = []
    const lifecycle = await verifiedLifecycle()
    const rejecting = createServerVersionLifecycle({
      layout: { home, versions: path.join(home, 'versions'), version: '0.3.0' },
      verifyBoot: async () => { throw new Error('Account boot exited before serving (1)') },
    })
    const c = createAccountVersionConverger({
      lifecycle: { ...lifecycle, stage: rejecting.stage },
      layout: { home, versions: path.join(home, 'versions'), version: '0.3.0' },
      log: quietLog,
      running: () => '0.3.0',
      restart: () => undefined,
      now: () => t,
      busy: () => false,
      stage: async (v) => { staged.push(v) },
    })
    const update = () => JSON.parse(fs.readFileSync(path.join(dataDir(U1), 'server-update.json'), 'utf8'))
    c.converge(listAccounts())
    await flush()
    c.converge(listAccounts())
    expect(staged).toEqual(['0.3.1'])
    expect(update()).toMatchObject({ state: 'failed', version: '0.3.1', reason: 'boot-failed' })
    t += 1000
    expect(requestVersionRetry({ GUGU_SERVER_MODE: '1', GUGU_TASK_HOST_USER_DATA: dataDir(U1) }, t)).toBe(true)
    c.converge(listAccounts())
    await flush()
    expect(staged).toEqual(['0.3.1'])
    expect(update()).toMatchObject({ state: 'failed', version: '0.3.1', reason: 'boot-failed' })
    t += 1000
    requestVersionSwitch(dataDir(U1), 'confirmed restart from desktop', t, true, '0.3.1')
    c.converge(listAccounts())
    await flush()
    expect(staged).toEqual(['0.3.1', '0.3.1'])
  })

  it('连不上下载站:设备行照报「更新没成功」,并记下 reason=unreachable(桌面读到它就把包的字节传过来);别的失败不带', async () => {
    signIn(U1)
    installVersion('0.3.0')
    report(U1, 'mbp', '0.3.1')
    let error: Error = new DownloadSiteUnreachableError('下载站上没有 0.3.1 这一版(连不上)')
    let t = NOW
    const c = createAccountVersionConverger({
      lifecycle: await verifiedLifecycle(),
      layout: { home, versions: path.join(home, 'versions'), version: '0.3.0' },
      log: quietLog,
      running: () => '0.3.0',
      restart: () => undefined,
      now: () => t,
      busy: () => false,
      stage: async () => { throw error },
    })
    const update = () => JSON.parse(fs.readFileSync(path.join(dataDir(U1), 'server-update.json'), 'utf8'))
    c.converge(listAccounts())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(update()).toMatchObject({ state: 'failed', version: '0.3.1', reason: 'unreachable' })
    error = new Error('包校验不通过')
    t += 1000
    fs.writeFileSync(path.join(dataDir(U1), VERSION_SWITCH_FILE), JSON.stringify({ reason: 'retry', at: t }))
    c.converge(listAccounts())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(update()).toMatchObject({ state: 'failed', version: '0.3.1' })
    expect(update().reason).toBeUndefined()
  })

  it('下载站上还没有这一版(server 包比桌面包晚发):❌ 冷却,先让位给能装的那一版,5 分钟后再取;真失败照旧冷却 6 小时', async () => {
    signIn(U1)
    installVersion('0.3.0')
    report(U1, 'dev', '0.3.1')
    let t = NOW
    let outcome: 'not-published' | 'broken' | 'ok' = 'not-published'
    const staged: string[] = []
    const c = createAccountVersionConverger({
      lifecycle: await verifiedLifecycle(),
      layout: { home, versions: path.join(home, 'versions'), version: '0.3.0' },
      log: quietLog,
      running: () => '0.3.0',
      restart: () => undefined,
      now: () => t,
      busy: () => true,
      stage: async (v) => {
        staged.push(v)
        if (outcome === 'not-published') throw new VersionNotPublishedError('404')
        if (outcome === 'broken') throw new Error('包校验不通过')
        installVersion(v)
      },
    })
    const update = () => JSON.parse(fs.readFileSync(path.join(dataDir(U1), 'server-update.json'), 'utf8'))
    c.converge(listAccounts())
    await flush()
    t += VERSION_NOT_PUBLISHED_RETRY_MS - 1
    c.converge(listAccounts())
    expect(staged).toEqual(['0.3.1'])
    // 等 0.3.1 发出来的这几分钟里它让位:没有别的报告 ⇒ 跟守护进程 0.3.0,账号已经在跑 ⇒ 设备行没有待办。
    expect(fs.existsSync(path.join(dataDir(U1), 'server-update.json'))).toBe(false)
    // 5 分钟到了、包也发出来了:再取一次,装好。
    t += 1
    outcome = 'ok'
    c.converge(listAccounts())
    await flush()
    c.converge(listAccounts())
    expect(staged).toEqual(['0.3.1', '0.3.1'])
    expect(update()).toMatchObject({ state: 'ready', version: '0.3.1' })
    // 同一台机器上真失败:照旧冷却 6 小时。
    report(U1, 'dev', '0.3.2')
    outcome = 'broken'
    c.converge(listAccounts())
    await flush()
    t += VERSION_FAILURE_COOLDOWN_MS - 1
    c.converge(listAccounts())
    expect(staged).toEqual(['0.3.1', '0.3.1', '0.3.2'])
    expect(update()).toMatchObject({ state: 'failed', version: '0.3.2' })
  })

  it('下载站上一直没有的版本(没打后缀的测试包):退回次新的那一版,再看的间隔翻倍到 6 小时,❌ 每 5 分钟 404 一次', async () => {
    signIn(U1)
    for (const v of ['0.3.0', '0.2.9']) installVersion(v)
    report(U1, 'alice-mbp', '0.2.9')
    report(U1, 'test-pkg', '0.3.1')
    let t = NOW
    const staged: number[] = []
    const switched: string[] = []
    let running = '0.3.0'
    const c = createAccountVersionConverger({
      lifecycle: await verifiedLifecycle(),
      layout: { home, versions: path.join(home, 'versions'), version: '0.3.0' },
      log: quietLog,
      running: () => running,
      restart: (userId) => {
        switched.push(userId)
        running = JSON.parse(fs.readFileSync(path.join(dataDir(userId), 'server-version.json'), 'utf8')).version
      },
      now: () => t,
      busy: () => false,
      stage: async () => {
        staged.push(t - NOW)
        throw new VersionNotPublishedError('404')
      },
    })
    // 每分钟一轮,跑 8 小时。
    for (let minute = 0; minute <= 8 * 60; minute += 1) {
      t = NOW + minute * 60_000
      c.converge(listAccounts())
      await flush()
    }
    const min = 60_000
    expect(staged).toEqual([0, 5, 15, 35, 75, 155, 315].map((m) => m * min))
    // 404 之后当场换去次新的 0.2.9(空闲),❌ 一直停在守护进程那一版等。
    expect(switched).toEqual([U1])
    expect(running).toBe('0.2.9')
  })

  it('上一个守护进程留下的「更新没成功」:换了守护进程、账号已跑在目标版本上 ⇒ 第一轮就清掉,❌ 挂到过期', async () => {
    signIn(U1)
    installVersion('0.3.0')
    report(U1, 'dev', '0.3.0')
    const file = path.join(dataDir(U1), 'server-update.json')
    fs.writeFileSync(file, JSON.stringify({ state: 'failed', version: '0.3.0', at: NOW - 1000 }))
    const { c } = await converger(new Map([[U1, '0.3.0']]))
    c.converge(listAccounts())
    expect(fs.existsSync(file)).toBe(false)
  })

  it('用它的桌面都很久没来(报告全过期):空闲时回到这台机器自己的版本', async () => {
    signIn(U1)
    for (const v of ['0.3.0', '0.2.9']) installVersion(v)
    report(U1, 'old', '0.2.9', 2, NOW - DESKTOP_REPORT_TTL_MS - 1)
    writeAccountVersionPin(dataDir(U1), { version: '0.2.9', previous: null, at: NOW })
    const { c, restarted } = await converger(new Map([[U1, '0.2.9']]))
    c.converge(listAccounts())
    expect(restarted).toEqual([U1])
    expect(readAccountVersionPin(dataDir(U1))?.version).toBe('0.3.0')
    expect(c.binaryFor(U1)).toBeNull()
  })

  it('换过去秒退三次:退回原来那一版', async () => {
    signIn(U1)
    for (const v of ['0.3.0', '0.3.1']) installVersion(v)
    report(U1, 'mbp', '0.3.1')
    const { c } = await converger(new Map([[U1, '0.3.0']]))
    c.converge(listAccounts())
    c.quickExit(U1, '0.3.1')
    c.quickExit(U1, '0.3.1')
    expect(readAccountVersionPin(dataDir(U1))?.version).toBe('0.3.1')
    c.quickExit(U1, '0.3.1')
    expect(readAccountVersionPin(dataDir(U1))?.version).toBe('0.3.0')
    // 记进那本唯一的「起不来」账:守护进程追通道时也会跳过它,下一轮这个账号也不再换过去(冷却期内)。
    expect(readBadVersions(home)['0.3.1']).toBe(NOW)
  })
})

describe('reclamation uses explicit ownership only', () => {
  it('keeps explicitly protected versions without additional mtime guesses', () => {
    const installed = ['0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7', '.download-x'].map((name, i) => ({ name, mtimeMs: i }))
    const keep = versionsToKeep({ installed, inUse: ['0.1.0'] })
    expect([...keep].sort()).toEqual(['0.1.0'])
  })

  it('pruneVersions:账号记着的旧版本不删,下载中的临时目录不碰', () => {
    for (let i = 0; i < 9; i++) installVersion(`0.1.${i}`, NOW + i * 1000)
    fs.mkdirSync(path.join(home, 'versions', '.download-abc'))
    signIn(U1)
    writeAccountVersionPin(dataDir(U1), { version: '0.1.0', previous: null, at: NOW })
    const removed = pruneVersions(path.join(home, 'versions'), ['0.1.0', '0.1.8'])
    expect(removed.sort()).toEqual(['0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7'])
    expect(fs.readdirSync(path.join(home, 'versions')).sort()).toEqual(['.download-abc', '0.1.0', '0.1.8'])
  })

  it('bootstrap installer leaves reclamation to the supervisor', () => {
    const INSTALL = path.join(__dirname, '../../../../scripts/gugu-server/install.sh')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-install-keep-'))
    const userHome = path.join(dir, 'home')
    const serverHome = path.join(userHome, '.gugu-server')
    fs.mkdirSync(userHome)
    const install = (version: string, extra: string[] = []) => {
      const root = path.join(dir, `src-${version}`, `gugu-server-${version}`)
      fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
      fs.writeFileSync(path.join(root, 'bin', 'gugu-server'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const file = path.join(dir, `pkg-${version}.tar.gz`)
      execFileSync('tar', ['-czf', file, '-C', path.dirname(root), path.basename(root)])
      const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      execFileSync('sh', [INSTALL, '--package', file, '--version', version, '--sha256', sha, '--no-login', '--no-service', ...extra], {
        env: { ...process.env, HOME: userHome, GUGU_SERVER_HOME: serverHome },
        stdio: 'pipe',
      })
      // 目录时刻按装的先后错开(同一秒里装完,ls -t 分不出先后)。
      const t = NOW / 1000 + Number(version.split('.')[2]) * 10
      fs.utimesSync(path.join(serverHome, 'versions', version), t, t)
    }
    install('0.1.1')
    fs.mkdirSync(path.join(serverHome, 'accounts', U1, 'data'), { recursive: true })
    fs.writeFileSync(path.join(serverHome, 'accounts', U1, 'data', 'server-version.json'), JSON.stringify({ version: '0.1.1', previous: null, at: NOW }))
    for (const v of ['0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7', '0.1.8', '0.1.9']) install(v)
    const versions = fs.readdirSync(path.join(serverHome, 'versions')).filter((n) => !n.startsWith('.')).sort()
    // Bootstrap never guesses live versions; only the supervisor reclaims with actual ownership facts.
    expect(versions).toEqual(['0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7', '0.1.8', '0.1.9'])
    expect(fs.readlinkSync(path.join(serverHome, 'current'))).toBe('versions/0.1.9')
    // --keep-current:只装不切。
    install('0.1.0', ['--keep-current'])
    expect(fs.existsSync(path.join(serverHome, 'versions', '.prepared', '0.1.0'))).toBe(true)
    expect(fs.readlinkSync(path.join(serverHome, 'current'))).toBe('versions/0.1.9')
    expect(fs.existsSync(path.join(serverHome, 'versions', '0.1.0', 'bin', 'gugu-server'))).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('gugu-server match-version', () => {
  it('参数:报告 / 换过去两种;形状不对拒绝', () => {
    expect(parseMatchArgs(['--account', U1, '--desktop', 'mbp', '--version', '0.2.9', '--protocol', '2'])).toEqual({ mode: 'report', account: U1, desktop: 'mbp', version: '0.2.9', protocol: 2 })
    expect(parseMatchArgs([`--account=${U1}`, '--apply=0.2.9'])).toEqual({ mode: 'apply', account: U1, version: '0.2.9', now: false })
    expect(parseMatchArgs(['--account', U1, '--apply', '0.2.9', '--now'])).toEqual({ mode: 'apply', account: U1, version: '0.2.9', now: true })
    expect(parseMatchArgs(['--account', U1, '--desktop', 'mbp', '--version', '../x'])).toHaveProperty('error')
  })

  it('报告:打出目标(同账号取最新)、在跑的、装没装;换过去:没装也请守护进程换,等这个账号真的跑上那一版', async () => {
    signIn(U1)
    installVersion('0.3.0')
    report(U1, 'home', '0.3.1')
    const out: string[] = []
    let running = '0.3.0'
    let clock = NOW
    const deps = { home, runningVersion: () => running, supervisorRunning: () => true, now: () => (clock += 100), sleep: async () => { running = '0.3.1' }, waitMs: 5_000 }
    expect(await runMatchVersion(['--account', U1, '--desktop', 'office', '--version', '0.3.0', '--protocol', '2'], (l) => out.push(l), () => undefined, deps)).toBe(0)
    expect(out.pop()).toBe('__GUGU_MATCH__ target=0.3.1 running=0.3.0 installed=0 supervisor=1')
    // 0.3.1 没装:❌ 拒绝(装由守护进程收到换版请求后自己装),等它装好换过去。
    expect(await runMatchVersion(['--account', U1, '--apply', '0.3.1'], (l) => out.push(l), () => undefined, deps)).toBe(0)
    expect(out.pop()).toBe('__GUGU_MATCH__ switched=0.3.1')
    expect(readVersionSwitchRequest(dataDir(U1), clock)).not.toBeNull()
  })

  it('换过去:守护进程在这次请求之后记下「装失败」⇒ 当场退 6,「连不上下载站」⇒ 退 7 要字节(❌ 干等到超时);更早的失败 ⇒ 接着等', async () => {
    signIn(U1)
    installVersion('0.3.0')
    const failedAt = (at: number, reason?: string) => JSON.stringify({ state: 'failed', version: '0.3.1', at, ...(reason ? { reason } : {}) })
    const errors: string[] = []
    const base = { home, runningVersion: () => '0.3.0', supervisorRunning: () => true, sleep: async () => undefined, waitMs: 1_000 }
    const apply = (deps: Partial<Parameters<typeof runMatchVersion>[3]>) => {
      let clock = NOW
      return runMatchVersion(['--account', U1, '--apply', '0.3.1'], () => undefined, (l) => errors.push(l), { ...base, now: () => (clock += 100), ...deps })
    }
    expect(await apply({ readUpdateState: () => failedAt(NOW + 500) })).toBe(6)
    expect(errors.pop()).toContain('装 0.3.1 失败了')
    expect(await apply({ readUpdateState: () => failedAt(NOW - 1) })).toBe(4)
    expect(errors.pop()).toContain('0.3.1 还没装好,装好后会自己换过去')
    expect(await apply({ readUpdateState: () => failedAt(NOW + 500, 'unreachable') })).toBe(7)
    expect(errors.pop()).toContain('连不上下载站')
  })

  it('换过去失败的原因与当前版本照实说:起不来 ⇒ 说启动失败过、要确认重启;没有账号进程 ⇒ 照守护进程记的子进程状态说', async () => {
    signIn(U1)
    installVersion('0.3.0')
    const errors: string[] = []
    const apply = (reason: string | undefined, child: 'restarting' | 'not-started' | null) => {
      let clock = NOW
      return runMatchVersion(['--account', U1, '--apply', '0.3.1'], () => undefined, (l) => errors.push(l), {
        home, runningVersion: () => null, supervisorRunning: () => true, sleep: async () => undefined, waitMs: 1_000,
        now: () => (clock += 100), accountChildState: () => child,
        readUpdateState: () => JSON.stringify({ state: 'failed', version: '0.3.1', at: NOW + 500, ...(reason ? { reason } : {}) }),
      })
    }
    expect(await apply('boot-failed', 'restarting')).toBe(6)
    expect(errors.pop()).toMatch(/0\.3\.1 在这台机器上启动失败过.*--apply 0\.3\.1 --now.*当前版本 \(正在重启\)/)
    expect(await apply(undefined, 'not-started')).toBe(6)
    expect(errors.pop()).toMatch(/装 0\.3\.1 失败了.*\(没有能启动的版本,未启动\)/)
  })

  it('换过去:这个账号有 agent 在跑、守护进程在等空闲 ⇒ 当场退 8(桌面问人);--now 不退,请求带上「人确认过」', async () => {
    signIn(U1)
    installVersion('0.3.0')
    const ready = JSON.stringify({ state: 'ready', version: '0.3.1', at: NOW + 500 })
    const errors: string[] = []
    const run = (args: string[]) => {
      let clock = NOW
      return runMatchVersion(['--account', U1, '--apply', '0.3.1', ...args], () => undefined, (l) => errors.push(l), {
        home, runningVersion: () => '0.3.0', supervisorRunning: () => true, sleep: async () => undefined, waitMs: 1_000,
        now: () => (clock += 100), readUpdateState: () => ready,
      })
    }
    expect(await run([])).toBe(8)
    expect(errors.pop()).toContain('任务仍附着')
    expect(readVersionSwitchRequest(dataDir(U1), NOW + 1_000)).toMatchObject({ confirmed: false })
    expect(await run(['--now'])).toBe(4)
    expect(readVersionSwitchRequest(dataDir(U1), NOW + 1_000)).toMatchObject({ confirmed: true })
  })
})

describe('远程 SSH:桌面替这个账号换成匹配的那一版', () => {
  type Remote = { target: string; running: string; installed: boolean; match?: boolean; online?: boolean; incoming?: boolean; busy?: boolean }
  function fakeSsh(remote: Remote, seen: string[]): SpawnSsh {
    return async (args, { stdin, onStderr }) => {
      const text = typeof stdin === 'string' ? stdin : `<file ${stdin.file}> → ${args.at(-1)}`
      seen.push(text)
      onStderr?.('Authenticated to box ([10.0.0.5]:22) using "publickey".\n')
      if (text.includes(PROBE_BEGIN)) {
        const lines = [PROBE_BEGIN, 'os=Linux', 'arch=x86_64', 'user=alice', 'hostname=box', 'libc=glibc 2.35', `installed=${remote.running}`, 'grant=1',
          ...(remote.match === false ? [] : ['match=1']), 'protocol_exit=0', 'protocol=2', 'running=1', 'fetcher=curl', 'freekb=50000000', 'exec=1', PROBE_END]
        return { code: 0, stdout: lines.join('\n'), stderr: '' }
      }
      if (text.includes('match-version') && text.includes('--apply')) {
        // 连不上下载站的机器:守护进程下载失败、记下 unreachable ⇒ --apply 退 7;字节放进 incoming 之后才装得上。
        if (remote.online === false && !remote.incoming) return { code: 7, stdout: '', stderr: '这台机器连不上下载站,装不了:要把包传过来\n' }
        if (remote.busy && !text.includes('--now')) return { code: 8, stdout: '', stderr: '这个账号有 agent 在跑,空闲后会自己换到那一版\n' }
        remote.running = remote.target
        return { code: 0, stdout: `__GUGU_MATCH__ switched=${remote.target}\n`, stderr: '' }
      }
      if (text.includes('match-version')) {
        return { code: 0, stdout: `rc 横幅\n__GUGU_MATCH__ target=${remote.target} running=${remote.running} installed=${remote.installed ? 1 : 0} supervisor=1\n`, stderr: '' }
      }
      if (text.includes('.incoming')) {
        if (text.includes('desktop-upload')) remote.incoming = true
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 127, stdout: '', stderr: 'unexpected' }
    }
  }
  const deps = (spawnSsh: SpawnSsh, extra: Partial<SshInstallDeps> = {}): SshInstallDeps => ({
    spawnSsh,
    mintGrant: async () => ({ error: 'grantFailed' }),
    desktopDownload: async () => { throw new Error('not used') },
    currentUserId: async () => null,
    controlPath: null,
    downloadBase: 'https://d',
    customDownloadBase: false,
    channel: 'stable',
    signal: new AbortController().signal,
    mode: 'upgrade',
    match: { accountUserId: U1, desktop: { id: 'mbp', version: '0.2.9', protocol: 2 } },
    ...extra,
  })
  const run = (remote: Remote, seen: string[], extra: Partial<SshInstallDeps> = {}) =>
    runSshInstall({ destination: 'box', display: 'box' }, new InstallRun('r', 'box', () => undefined), deps(fakeSsh(remote, seen), extra))
  const steps = (final: Awaited<ReturnType<typeof run>>) => Object.fromEntries(final.steps.map((s) => [s.id, s.status]))
  // 桌面经 SSH 装过东西的痕迹:install.sh、整台的 service install、上传后装包。
  const installedByDesktop = (seen: string[]) => seen.some((t) => t.includes('--keep-current') || t.includes('--no-login') || t.includes('--package') || t.includes('service install'))
  /** 升级器跑完报出来的那一件(第一个不是 updating 的事件):等它,❌ 按墙钟等。 */
  const settled = () => {
    const events: SshUpgradeEvent[] = []
    let done: (event: SshUpgradeEvent) => void = () => undefined
    const final = new Promise<SshUpgradeEvent>((resolve) => { done = resolve })
    return { events, final, emit: (event: SshUpgradeEvent) => { events.push(event); if (event.phase !== 'updating') done(event) } }
  }

  it('降级:目标 0.2.9 没装 ⇒ 桌面只报版本、请它换(那台机器的守护进程自己下载装上);❌ 桌面经 SSH 装、❌ service install', async () => {
    const remote: Remote = { target: '0.2.9', running: '0.3.0', installed: false }
    const seen: string[] = []
    const final = await run(remote, seen)
    expect(final.failure).toBeNull()
    expect(final.match).toEqual({ target: '0.2.9', running: '0.3.0' })
    expect(seen.some((t) => t.includes(`match-version --account ${U1} --apply 0.2.9`))).toBe(true)
    expect(installedByDesktop(seen)).toBe(false)
    expect(final.steps.find((s) => s.id === 'download')).toMatchObject({ status: 'done', via: 'remote', version: '0.2.9' })
    expect(steps(final)).toMatchObject({ download: 'done', service: 'done', login: 'skipped' })
  })

  it('那个账号有 agent 在跑(--apply 退 8):停在 agentsRunning、❌ 当成换版失败;人点「现在重启更新」带 --now 才当场换', async () => {
    const remote: Remote = { target: '0.3.1', running: '0.3.0', installed: true, busy: true }
    const seen: string[] = []
    const waiting = await run(remote, seen)
    expect(waiting.failure?.reason).toBe('agentsRunning')
    expect(remote.running).toBe('0.3.0')
    const final = await run(remote, seen, { now: true })
    expect(final.failure).toBeNull()
    expect(seen.at(-1)).toContain(`match-version --account ${U1} --apply 0.3.1 --now`)
    expect(remote.running).toBe('0.3.1')
  })

  it('那台机器连不上下载站(它自己下载失败、--apply 退 7):本机下好那一版,经 SSH 只把字节放进它的 versions/.incoming(先包、后清单行),再请它换一次;❌ 桌面在那边装', async () => {
    const remote: Remote = { target: '0.2.9', running: '0.3.0', installed: false, online: false }
    const seen: string[] = []
    const asked: string[] = []
    const final = await run(remote, seen, {
      desktopDownload: async ({ manifestUrl, expectVersion }) => {
        asked.push(`${manifestUrl} ${expectVersion}`)
        return { version: '0.2.9', sha256: 'b'.repeat(64), file: '/tmp/pkg.tgz', size: 10, installSh: '' }
      },
    })
    expect(final.failure).toBeNull()
    expect(asked).toEqual(['https://d/0.2.9/linux-x64.txt 0.2.9'])
    const at = (needle: string) => seen.findIndex((t) => t.includes(needle))
    expect(seen[at('<file /tmp/pkg.tgz>')]).toContain('/versions/.incoming/0.2.9.tar.gz.part && mv')
    expect(seen[at('desktop-upload')]).toContain(`'0.2.9 ${'b'.repeat(64)} desktop-upload'`)
    const applies = seen.flatMap((t, i) => (t.includes('--apply') ? [i] : []))
    expect(applies).toHaveLength(2)
    expect(applies[0]).toBeLessThan(at('<file /tmp/pkg.tgz>'))
    expect(at('<file /tmp/pkg.tgz>')).toBeLessThan(at('desktop-upload'))
    expect(at('desktop-upload')).toBeLessThan(applies[1]!)
    expect(installedByDesktop(seen)).toBe(false)
    expect(final.steps.find((s) => s.id === 'download')).toMatchObject({ status: 'done', via: 'desktop' })
  })

  it('升级器:有 agent 在跑 ⇒ 报 waitingIdle(❌ failed);人点「现在重启更新」(force + now)不看冷却、带 --now 当场换', async () => {
    const remote: Remote = { target: '0.3.1', running: '0.3.0', installed: true, busy: true }
    const seen: string[] = []
    const first = settled()
    let emit = first.emit
    const upgrader = createSshAutoUpgrader({
      run: (_id, onState, options) =>
        runSshInstall({ destination: 'box', display: 'box' }, new InstallRun('r', 'box', onState), deps(fakeSsh(remote, seen), options?.now ? { now: true } : {})),
      emit: (event) => emit(event),
      desktopVersion: '0.3.1',
    })
    upgrader.request('d22')
    expect(await first.final).toEqual({ deviceId: 'd22', phase: 'waitingIdle' })
    expect(upgrader.request('d22')).toBe(false)
    const second = settled()
    emit = second.emit
    expect(upgrader.request('d22', { force: true, now: true })).toBe(true)
    expect(await second.final).toEqual({ deviceId: 'd22', phase: 'done' })
    expect(remote.running).toBe('0.3.1')
  })

  it('已经是目标(同账号另一台桌面更新)⇒ 什么也不换;升级器报 desktopTooOld(❌ 更新没成功)', async () => {
    const remote: Remote = { target: '0.3.0', running: '0.3.0', installed: true }
    const seen: string[] = []
    const { final, emit } = settled()
    const upgrader = createSshAutoUpgrader({
      run: (_id, onState) => runSshInstall({ destination: 'box', display: 'box' }, new InstallRun('r', 'box', onState), deps(fakeSsh(remote, seen))),
      emit,
      desktopVersion: '0.2.9',
    })
    upgrader.request('d22', { desktopTooOld: true })
    expect(await final).toEqual({ deviceId: 'd22', phase: 'desktopTooOld' })
    expect(seen.some((t) => t.includes('--apply'))).toBe(false)
  })

  it('那台机器不认得 match-version(#6504 之前的构建):❌ 替它整台重装;没升成,界面拿到在那台机器上重装的命令', async () => {
    const remote: Remote = { target: '0.3.0', running: '0.2.40', installed: true, match: false }
    const seen: string[] = []
    const { final, emit } = settled()
    const upgrader = createSshAutoUpgrader({
      run: (_id, onState) => runSshInstall({ destination: 'box', display: 'box' }, new InstallRun('r', 'box', onState), deps(fakeSsh(remote, seen), { channel: 'beta' })),
      emit,
      desktopVersion: '0.3.0',
    })
    upgrader.request('d22')
    expect(await final).toEqual({ deviceId: 'd22', phase: 'failed', reinstall: 'curl -fsSL https://d/install.sh | sh -s -- --channel beta' })
    // 只连上去看了一眼(识别系统),之后什么也没跑。
    expect(seen.filter((t) => !t.includes(PROBE_BEGIN))).toEqual([])
  })
})

describe('「更新没成功」随心跳报到设备行', () => {
  it('failed 状态认得、按时过期;设备行解析时保留', () => {
    expect(parseServerUpdateState(JSON.stringify({ state: 'failed', version: '0.2.9', at: NOW }), NOW + 1000)).toEqual({ state: 'failed', version: '0.2.9' })
    expect(parseServerUpdateState(JSON.stringify({ state: 'failed', version: '0.2.9', at: NOW }), NOW + 11 * 60_000)).toBeNull()
    expect(normalizeDeviceCapabilities({ host_kind: 'server', server_update: { state: 'failed', version: '0.2.9' } }).server_update).toEqual({ state: 'failed', version: '0.2.9' })
  })
})

describe('测试环境:桌面报给 server 的版本可覆盖', () => {
  it('正式版报自己的版本;开发(没打包)或用测试下载站时 GUGU_SERVER_MATCH_VERSION 覆盖;打包的正式版忽略它', () => {
    const env = { GUGU_APP_VERSION: '0.2.50', GUGU_SERVER_MATCH_VERSION: '0.2.161' }
    const published = true
    expect(reportedDesktopVersion({ GUGU_APP_VERSION: '0.2.160' }, { packaged: true, published })).toBe('0.2.160')
    expect(reportedDesktopVersion(env, { packaged: false, published })).toBe('0.2.161')
    expect(reportedDesktopVersion({ ...env, GUGU_SERVER_DOWNLOAD_BASE: 'http://203.0.113.10:30027' }, { packaged: true, published })).toBe('0.2.161')
    expect(reportedDesktopVersion(env, { packaged: true, published })).toBe('0.2.50')
    expect(reportedDesktopVersion({ ...env, GUGU_SERVER_MATCH_VERSION: '../x' }, { packaged: false, published })).toBe('0.2.50')
  })
  it('不是发布流水线出的包(开发实例、本地打的测试包):❌ 报自己的版本号 —— 那个号下载站上从来没有;显式覆盖照旧', () => {
    const published = false
    expect(reportedDesktopVersion({ GUGU_APP_VERSION: '0.2.58' }, { packaged: true, published })).toBeNull()
    expect(reportedDesktopVersion({ GUGU_APP_VERSION: '0.2.58' }, { packaged: false, published })).toBeNull()
    expect(reportedDesktopVersion({ GUGU_APP_VERSION: '0.2.58', GUGU_SERVER_MATCH_VERSION: '0.2.58-beta.1042.1' }, { packaged: false, published })).toBe('0.2.58-beta.1042.1')
  })
})

// The download-site manifest backfill script and its case belong to the official release tooling, not this repository.
describe('测试下载站补「钉在这一版上的清单」', () => {
  it('fetchVersionManifest:先读钉在这一版上的清单;没有时通道清单正好是这一版也认;都不是就说没有', async () => {
    const prev = process.env.GUGU_SERVER_DOWNLOAD_BASE
    process.env.GUGU_SERVER_DOWNLOAD_BASE = 'http://cdn'
    const sha = 'a'.repeat(64)
    const files: Record<string, string> = {}
    const fetchFile = async (url: string) => (url in files ? new Response(files[url]) : new Response('', { status: 404 }))
    const key = (dir: string) => Object.keys(files).find((k) => k.includes(`/${dir}/`))
    files[`http://cdn/stable/${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.txt`] = `0.2.161 ${sha} http://cdn/x.tgz`
    expect((await fetchVersionManifest(home, '0.2.161', fetchFile)).version).toBe('0.2.161')
    // 通道已经越过要的这一版:永远不会有,是真失败。
    await expect(fetchVersionManifest(home, '0.2.150', fetchFile)).rejects.toThrow('没有 0.2.150')
    await expect(fetchVersionManifest(home, '0.2.150', fetchFile)).rejects.not.toThrow(VersionNotPublishedError)
    // 通道还停在更旧的版本:还没发。
    await expect(fetchVersionManifest(home, '0.2.170', fetchFile)).rejects.toThrow(VersionNotPublishedError)
    // 通道也 404(下载站 / 前缀配错):真失败。
    const nothing = async () => new Response('', { status: 404 })
    await expect(fetchVersionManifest(home, '0.2.170', nothing)).rejects.toThrow('没有 0.2.170')
    await expect(fetchVersionManifest(home, '0.2.170', nothing)).rejects.not.toThrow(VersionNotPublishedError)
    // 下载站出错 / 连不上照旧是失败。
    const down = async () => new Response('', { status: 500 })
    await expect(fetchVersionManifest(home, '0.2.150', down)).rejects.toThrow('没有 0.2.150')
    await expect(fetchVersionManifest(home, '0.2.150', down)).rejects.not.toThrow(VersionNotPublishedError)
    const offline = async (): Promise<Response> => { throw new Error('ECONNREFUSED') }
    await expect(fetchVersionManifest(home, '0.2.150', offline)).rejects.not.toThrow(VersionNotPublishedError)
    const pinned = key('stable')!.replace('/stable/', '/0.2.150/')
    files[pinned] = `0.2.150 ${sha} http://cdn/y.tgz`
    expect((await fetchVersionManifest(home, '0.2.150', fetchFile)).url).toBe('http://cdn/y.tgz')
    if (prev === undefined) delete process.env.GUGU_SERVER_DOWNLOAD_BASE
    else process.env.GUGU_SERVER_DOWNLOAD_BASE = prev
  })
})

describe('同一台电脑上两个版本的咕咕(正式版 + Beta / 开发实例)不互相覆盖(#6264 实测 d22 来回切版本)', () => {
  it('报告标识带版本;两条都在时取最新那一版,不随上报顺序来回变', async () => {
    const { desktopReportId } = await import('@gugu/core/cloud/serverMachineHealth')
    const { pickTargetVersion } = await import('@gugu/core/cloud/serverDesktopVersions')
    const now = Date.now()
    const a = desktopReportId('dev-1', '0.2.162')
    const b = desktopReportId('dev-1', '0.2.170')
    expect(a).not.toBe(b)
    const first = { [a]: { version: '0.2.162', protocol: 2, at: now - 1000 }, [b]: { version: '0.2.170', protocol: 2, at: now - 2000 } }
    const second = { [a]: { version: '0.2.162', protocol: 2, at: now - 3000 }, [b]: { version: '0.2.170', protocol: 2, at: now - 500 } }
    expect(pickTargetVersion(first, now)).toBe('0.2.170')
    expect(pickTargetVersion(second, now)).toBe('0.2.170')
  })
})
