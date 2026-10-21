/*
 * #6264 远程 SSH 的机器上咕咕 server 太旧(owner 实测:d22 原装 0.2.131,桌面新版 → 永远「重连中」):
 * 这台桌面够得着它,就当场替它升级、升完自动连上(照 VS Code Remote-SSH)。这里钉住:
 *  · 设备连接开出「太旧」→ 发起升级、渲染层拿到「正在更新」,❌ 原样报太旧;
 *  · 一台只升一次;升失败冷却一阵不再自己试,人点「重试」不看冷却;
 *  · 「装着的并不旧」(什么也没装)算没升成,免得重连 → 又说太旧 → 又「升好了」地转圈;
 *  · 进度按下载那一步的真实字节报百分比。
 */
import { describe, expect, it } from 'vitest'
import {
  createSshAutoUpgrader,
  upgradePercent,
  type RunUpgrade,
} from '../../../../apps/desktop/electron/server/ssh-install/auto-upgrade'
import { InstallRun } from '../../../../apps/desktop/electron/server/ssh-install/runner'
import { openOutcome } from '../../../../apps/desktop/electron/server/ssh-link-ipc'
import type { ServerSshInstallState } from '../../../../apps/desktop/src/lib/serverSshInstall'
import type { SshUpgradeEvent } from '../../../../apps/desktop/src/lib/sshLink'

function state(patch: (draft: ServerSshInstallState) => void): ServerSshInstallState {
  const run = new InstallRun('r', 'd22', () => undefined)
  run.update(patch)
  return run.snapshot()
}

const upgraded = state((d) => {
  d.steps[2].status = 'done'
  d.steps[2].version = '0.2.160'
  d.finished = true
})
const nothingToDo = state((d) => {
  d.steps[2].status = 'skipped'
  d.finished = true
})
/** 装着的已够新、没下载,把在跑的旧进程当场切了过去(service 那一步换了)。 */
const switched = state((d) => {
  d.steps[2].status = 'skipped'
  d.steps[3].status = 'done'
  d.finished = true
})
const failed = state((d) => {
  d.steps[2].status = 'failed'
  d.failure = { step: 'download', reason: 'diskFull' }
  d.finished = true
})

function harness(outcomes: Array<ServerSshInstallState | null>, clock = { t: 0 }) {
  const events: SshUpgradeEvent[] = []
  const runs: string[] = []
  const pending: Array<() => void> = []
  const run: RunUpgrade = (deviceId, onState) => {
    runs.push(deviceId)
    const outcome = outcomes.shift() ?? null
    return new Promise((resolve) => {
      pending.push(() => {
        onState(state((d) => void (d.steps[2].progress = { phase: 'download', done: 50, total: 200 })))
        resolve(outcome)
      })
    })
  }
  const upgrader = createSshAutoUpgrader({ run, emit: (e) => events.push(e), now: () => clock.t, cooldownMs: 1000 })
  const finish = async () => {
    pending.shift()?.()
    await new Promise((r) => setTimeout(r, 0))
  }
  return { upgrader, events, runs, finish, clock }
}

describe('设备连接开出「太旧」→ 当场替它升级', () => {
  it('SSH 机器太旧:发起升级、渲染层拿到 updating(❌ 原样报 outdated);升好自动连上(done)', async () => {
    const h = harness([upgraded])
    expect(openOutcome('d22', { ok: false, reason: 'outdated' }, h.upgrader)).toEqual({ ok: false, reason: 'updating' })
    expect(h.runs).toEqual(['d22'])
    // 正在升时又开一次:❌ 再起一次升级
    expect(openOutcome('d22', { ok: false, reason: 'outdated' }, h.upgrader)).toEqual({ ok: false, reason: 'updating' })
    expect(h.runs).toEqual(['d22'])
    expect(h.upgrader.upgrading('d22')).toBe(true)
    await h.finish()
    expect(h.upgrader.upgrading('d22')).toBe(false)
    expect(h.events).toEqual([
      { deviceId: 'd22', phase: 'updating', percent: null },
      { deviceId: 'd22', phase: 'updating', percent: 25 },
      { deviceId: 'd22', phase: 'done' },
    ])
  })

  it('其它原因、或没有升级器(远程隧道那条路不经这里):原样报', () => {
    const h = harness([])
    // 升级只因为版本:连不上 / 被拒绝 / 没在跑 / 要登录 / 没装 …… 一律照实报,❌ 发起升级。
    for (const reason of ['unreachable', 'refused', 'notRunning', 'signInRequired', 'hostKeyChanged', 'notSignedIn', 'notInstalled', 'unmapped'] as const) {
      expect(openOutcome('d22', { ok: false, reason }, h.upgrader)).toEqual({ ok: false, reason })
    }
    expect(openOutcome('d22', { ok: false, reason: 'outdated' }, null)).toEqual({ ok: false, reason: 'outdated' })
    expect(openOutcome('d22', { ok: true }, h.upgrader)).toEqual({ ok: true })
    expect(h.runs).toEqual([])
  })

  it('升失败:报 failed;冷却内再开只报太旧(❌ 每次重连都重下一遍包);人点重试不看冷却;冷却过了自己再试', async () => {
    const h = harness([failed, failed, upgraded])
    expect(h.upgrader.request('d22')).toBe(true)
    await h.finish()
    expect(h.events.at(-1)).toEqual({ deviceId: 'd22', phase: 'failed' })
    expect(openOutcome('d22', { ok: false, reason: 'outdated' }, h.upgrader)).toEqual({ ok: false, reason: 'outdated' })
    expect(h.runs).toHaveLength(1)
    expect(h.upgrader.request('d22', { force: true })).toBe(true)
    await h.finish()
    expect(h.runs).toHaveLength(2)
    h.clock.t = 1001
    expect(h.upgrader.request('d22')).toBe(true)
    await h.finish()
    expect(h.events.at(-1)).toEqual({ deviceId: 'd22', phase: 'done' })
  })

  it('装着的并不旧(什么也没装)/ 没有它的映射:算没升成,❌ 报「升好了」再转一圈', async () => {
    const h = harness([nothingToDo, null])
    h.upgrader.request('a')
    await h.finish()
    h.upgrader.request('b')
    await h.finish()
    expect(h.events.filter((e) => e.phase !== 'updating')).toEqual([
      { deviceId: 'a', phase: 'failed' },
      { deviceId: 'b', phase: 'failed' },
    ])
  })

  it('换过去了(match-version 亲眼看到这个账号跑上那一版)算升好;那台机器老到没法自动更新:没升成,带上重装命令给界面', async () => {
    const tooOld = state((d) => {
      d.steps[1].status = 'failed'
      d.failure = { step: 'detect', reason: 'serverTooOld', detail: 'curl -fsSL https://d/install.sh | sh' }
      d.finished = true
    })
    const h = harness([switched, tooOld])
    h.upgrader.request('d22')
    await h.finish()
    expect(h.events.at(-1)).toEqual({ deviceId: 'd22', phase: 'done' })
    h.upgrader.request('d22')
    await h.finish()
    expect(h.events.at(-1)).toEqual({ deviceId: 'd22', phase: 'failed', reinstall: 'curl -fsSL https://d/install.sh | sh' })
  })

  it('upgradePercent 按下载那一步的真实字节;总量不知道 = null', () => {
    expect(upgradePercent(state((d) => void (d.steps[2].progress = { phase: 'upload', done: 1, total: 3 })))).toBe(33)
    expect(upgradePercent(state((d) => void (d.steps[2].progress = { phase: 'download', done: 9, total: null })))).toBeNull()
    expect(upgradePercent(state(() => undefined))).toBeNull()
  })
})
