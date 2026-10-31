// #6264 升级看门狗:新版本切过去之后站稳了没有;没站稳就自动退回上一版,记下坏版本,请守护进程重启。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEADLINE_MS,
  judgeUpgrade,
  readBadVersions,
  readProbe,
  readUpgradeMarker,
  rollbackUpgrade,
  runGuardLoop,
  STABLE_MS,
  writeSupervisorHealth,
  writeUpgradeMarker,
  type GuardDeps,
  type Heartbeat,
  type UpgradeMarker,
} from '../../../../apps/desktop/electron/server/server-upgrade-guard'
import { writeVersionPin } from '../../../../apps/desktop/electron/server/server-account-versions'
import { SERVER_ROLLBACK_FILE } from '../../../../packages/core/src/cloud/deviceHostInfo'

const T0 = 1_000_000_000_000
const marker = (home = '/h'): UpgradeMarker => ({
  from: '0.2.139',
  to: '0.2.140',
  fromDir: path.join(home, 'versions', '0.2.139'),
  toDir: path.join(home, 'versions', '0.2.140'),
  switchedAt: T0,
})
const beat = (version: string, startedAt: number, at: number): Heartbeat => ({ version, startedAt, at })

describe('judgeUpgrade', () => {
  it('新版本的账号进程连续跑满一段时间 = 站稳了', () => {
    const now = T0 + STABLE_MS + 20_000
    expect(judgeUpgrade({ now, watchingSince: T0, marker: marker(), supervisor: null, accounts: [beat('0.2.140', T0 + 10_000, now - 5_000)] })).toBe('healthy')
  })

  it('账号进程在崩溃循环里(每次都刚起来)= 还没站稳;超过期限 = 失败', () => {
    const crashLoop = (now: number) => beat('0.2.140', now - 20_000, now - 5_000)
    expect(judgeUpgrade({ now: T0 + 60_000, watchingSince: T0, marker: marker(), supervisor: null, accounts: [crashLoop(T0 + 60_000)] })).toBe('waiting')
    const late = T0 + DEADLINE_MS + 1
    expect(judgeUpgrade({ now: late, watchingSince: T0, marker: marker(), supervisor: null, accounts: [crashLoop(late)] })).toBe('failed')
  })

  it('该跑新版本的账号还是旧版本在报(新版本压根没起来)不算站稳', () => {
    // 这里的账号没钉在别的版本上,按 current 该跑新版本 —— 它还在报旧版本,就是新版本没起来。
    // 钉在和桌面匹配的另一版上的账号报旧版本是本分,readProbe 不把它交进来(见下面 readProbe 那几条)。
    const now = T0 + DEADLINE_MS + 1
    expect(judgeUpgrade({ now, watchingSince: T0, marker: marker(), supervisor: null, accounts: [beat('0.2.139', T0 - 3_600_000, now - 1_000)] })).toBe('failed')
  })

  it('读数太久没续写(进程已经没了)不算', () => {
    const now = T0 + 5 * 60_000
    expect(judgeUpgrade({ now, watchingSince: T0, marker: marker(), supervisor: null, accounts: [beat('0.2.140', T0, T0 + STABLE_MS + 1)] })).toBe('waiting')
  })

  it('没有账号登录时看守护进程自己的读数', () => {
    const now = T0 + STABLE_MS + 30_000
    expect(judgeUpgrade({ now, watchingSince: T0, marker: marker(), supervisor: beat('0.2.140', T0 + 5_000, now - 1_000), accounts: [] })).toBe('healthy')
    expect(judgeUpgrade({ now, watchingSince: T0, marker: marker(), supervisor: null, accounts: [] })).toBe('waiting')
  })

  it('换版途中机器重启过:从重新开始盯算期限,❌ 一醒来就判失败', () => {
    const now = T0 + 3 * 3_600_000
    expect(judgeUpgrade({ now, watchingSince: now - 1_000, marker: marker(), supervisor: null, accounts: [null] })).toBe('waiting')
  })
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function fakeHome(current: '0.2.139' | '0.2.140' = '0.2.140'): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-guard-'))
  dirs.push(home)
  for (const v of ['0.2.139', '0.2.140']) {
    fs.mkdirSync(path.join(home, 'versions', v, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(home, 'versions', v, 'bin', 'gugu-server'), '#!/bin/sh\n', { mode: 0o755 })
  }
  fs.mkdirSync(path.join(home, 'data'), { recursive: true })
  fs.symlinkSync(`versions/${current}`, path.join(home, 'current'))
  return home
}

function deps(overrides: Partial<GuardDeps> = {}): GuardDeps & { killed: Array<[number, string]>; keeper: Array<number | undefined> } {
  let clock = T0
  const killed: Array<[number, string]> = []
  const keeper: Array<number | undefined> = []
  let alive = true
  return {
    killed,
    keeper,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    lockHolder: () => 777,
    kill: (pid, signal) => {
      killed.push([pid, signal])
      alive = false
    },
    isAlive: () => alive,
    restartsAutomatically: () => true,
    startKeeper: (waitPid) => keeper.push(waitPid),
    log: () => undefined,
    readMarker: () => null,
    readProbe: () => {
      throw new Error('not used')
    },
    ...overrides,
  }
}

describe('readProbe:账号钉在和桌面匹配的另一版上', () => {
  // ThinkPad 10-05..10-07 的读数:守护进程从 0.2.51-beta.46.1 往新版本切,唯一的账号钉在桌面那一版
  // (0.2.52-beta.53.1)上,心跳一直报那一版。以前它被当成「新版本没起来」,十分钟一到就回滚,五个版本全记成了坏版本。
  const account = (home: string, pin: string | null, heartbeat: Heartbeat) => {
    const data = path.join(home, 'accounts', 'u1', 'data')
    fs.mkdirSync(data, { recursive: true })
    fs.writeFileSync(path.join(data, 'server-session.enc'), 'x')
    fs.writeFileSync(path.join(data, 'activity.json'), JSON.stringify(heartbeat))
    if (pin) writeVersionPin(data, { version: pin, previous: null, at: T0 })
  }
  const installDesktopVersion = (home: string) => {
    fs.mkdirSync(path.join(home, 'versions', '0.2.138', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(home, 'versions', '0.2.138', 'bin', 'gugu-server'), '#!/bin/sh\n', { mode: 0o755 })
  }
  const now = T0 + STABLE_MS + 30_000

  it('钉在别的版本上的账号不算;守护进程自己在新版本上跑稳了 = 站稳', () => {
    const home = fakeHome()
    installDesktopVersion(home)
    account(home, '0.2.138', beat('0.2.138', T0 - 3_600_000, now - 1_000))
    writeSupervisorHealth(home, { version: '0.2.140', pid: 1, startedAt: T0 + 5_000 }, now - 1_000)
    const probe = readProbe(home, marker(home), T0, now)
    expect(probe.accounts).toEqual([])
    expect(judgeUpgrade(probe)).toBe('healthy')
  })

  it('守护进程自己也没在新版本上跑起来:照旧到期回滚', () => {
    const home = fakeHome()
    installDesktopVersion(home)
    const late = T0 + DEADLINE_MS + 1
    account(home, '0.2.138', beat('0.2.138', T0 - 3_600_000, late - 1_000))
    writeSupervisorHealth(home, { version: '0.2.139', pid: 1, startedAt: T0 - 3_600_000 }, late - 1_000)
    expect(judgeUpgrade(readProbe(home, marker(home), T0, late))).toBe('failed')
  })

  it('没钉、钉的就是新版本、钉的那一版已经不在盘上:都该跑新版本,照旧算进来', () => {
    for (const pin of [null, '0.2.140', '0.2.137']) {
      const home = fakeHome()
      account(home, pin, beat('0.2.139', T0 - 3_600_000, now - 1_000))
      expect(readProbe(home, marker(home), T0, now).accounts).toEqual([beat('0.2.139', T0 - 3_600_000, now - 1_000)])
    }
  })
})

describe('rollbackUpgrade', () => {
  it('切回上一版、记下坏版本与退回记录、请守护进程重启', async () => {
    const home = fakeHome()
    writeUpgradeMarker(home, marker(home))
    const d = deps()
    await expect(rollbackUpgrade(home, marker(home), d)).resolves.toBe(true)
    expect(fs.readlinkSync(path.join(home, 'current'))).toBe(path.join('versions', '0.2.139'))
    expect(Object.keys(readBadVersions(home))).toEqual(['0.2.140'])
    expect(JSON.parse(fs.readFileSync(path.join(home, 'data', SERVER_ROLLBACK_FILE), 'utf8'))).toMatchObject({ version: '0.2.140', restored: '0.2.139' })
    expect(readUpgradeMarker(home)).toBeNull()
    // SIGUSR2 =「请重启」,不是「请停」:systemd / launchd / 看门人会按 current 拉起旧版本。
    expect(d.killed).toEqual([[777, 'SIGUSR2']])
    expect(d.keeper).toEqual([])
  })

  it('没有人会自动拉起(老的兜底安装):自己请一个看门人,等旧进程退了再起', async () => {
    const home = fakeHome()
    const d = deps({ restartsAutomatically: () => false })
    await rollbackUpgrade(home, marker(home), d)
    expect(d.keeper).toEqual([777])
  })

  it('SIGUSR2 之后 45 秒还不走:SIGKILL', async () => {
    const home = fakeHome()
    const d = deps({ isAlive: () => true })
    const killed: Array<[number, string]> = []
    d.kill = (pid, signal) => void killed.push([pid, signal])
    await rollbackUpgrade(home, marker(home), d)
    expect(killed).toEqual([[777, 'SIGUSR2'], [777, 'SIGKILL']])
  })

  it('current 已经被人换走了(有人重新执行了安装命令):尊重他,不回滚', async () => {
    const home = fakeHome('0.2.139')
    writeUpgradeMarker(home, marker(home))
    const d = deps()
    await expect(rollbackUpgrade(home, marker(home), d)).resolves.toBe(false)
    expect(d.killed).toEqual([])
    expect(readBadVersions(home)).toEqual({})
    expect(readUpgradeMarker(home)).toBeNull()
  })
})

describe('runGuardLoop', () => {
  it('站稳了就撤掉标记、不碰任何进程', async () => {
    const home = fakeHome()
    writeUpgradeMarker(home, marker(home))
    let polls = 0
    const d = deps({
      readMarker: () => readUpgradeMarker(home),
      readProbe: (m, since) => {
        polls += 1
        const now = T0 + polls * 15_000
        return { now, watchingSince: since, marker: m, supervisor: null, accounts: [beat('0.2.140', T0, polls > 8 ? now : T0 + 1_000)] }
      },
    })
    await expect(runGuardLoop(home, d)).resolves.toBe('healthy')
    expect(readUpgradeMarker(home)).toBeNull()
    expect(d.killed).toEqual([])
  })

  it('十分钟没站稳就回滚', async () => {
    const home = fakeHome()
    writeUpgradeMarker(home, marker(home))
    const d = deps({ readMarker: () => readUpgradeMarker(home) })
    d.readProbe = (m, since) => ({ now: d.now(), watchingSince: since, marker: m, supervisor: null, accounts: [null] })
    await expect(runGuardLoop(home, d)).resolves.toBe('rolled-back')
    expect(fs.readlinkSync(path.join(home, 'current'))).toBe(path.join('versions', '0.2.139'))
  })

  it('标记没了(别人已经处理过):直接收手', async () => {
    const home = fakeHome()
    const sleep = vi.fn()
    await expect(runGuardLoop(home, deps({ sleep }))).resolves.toBe('abandoned')
    expect(sleep).not.toHaveBeenCalled()
  })
})
