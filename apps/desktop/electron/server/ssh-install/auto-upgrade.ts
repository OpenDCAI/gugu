/**
 * #6264 远程 SSH 的机器上咕咕 server 太旧、这台桌面连不上它:当场替它升级,升完自动连上。
 *
 * 照 VS Code Remote-SSH:客户端连上去发现 server 对不上,就装一份对得上的 —— ❌ 等那台机器「空闲时自己升」。
 * 旧到连不上的 server 上不可能有这台桌面能用的会话,等空闲没有要保护的东西;这台桌面够得着它(SSH),
 * 也就没有理由让人干等。远程隧道的机器够不着,维持空闲时自动更新(product spec 第 5 条)。
 *
 * 升级 = 同一条 SSH 装机流程的 upgrade 模式(runner.ts):报这台桌面的版本、请那台机器当场换、等它换过去;
 * 不登录、不问人(BatchMode)。装那一版的只有那台机器上的守护进程(server-account-converge.ts),桌面 ❌ 经 SSH 再装一份;
 * 那台机器上不了网时,桌面只把包的字节传过去。
 * 发起它的只有版本信号(ssh-link.ts classifyLinkExit / remoteSessionHost.ts unknown_method),连不上 ❌ 发起。
 * 一台机器同时只升一次;升失败了冷却一阵再自己试(免得每次重连都重下一遍包),人点「重试」不看冷却。
 *
 * #6264 升降都算:换的是「这个账号」到和桌面匹配的那一版(同一账号几台桌面取最新,
 * 可能比装着的旧 —— 降级),只重启这一个账号;目标就是在跑的那一版(同账号另一台桌面更新)= 这台桌面太旧,
 * 报 desktopTooOld,由它自己显示「请更新这台电脑上的咕咕」,❌ 算升级失败。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerSshInstallState } from '../../../src/lib/serverSshInstall'
import type { SshUpgradeEvent } from '../../../src/lib/sshLink'
import { compareServerVersions } from '@gugu/core/cloud/serverDesktopVersions'
import { serverDownloadBase } from '../server-download'
import { downloadServerOnDesktop } from './desktop-download'
import { SHARED_CONTROL_PERSIST, type SshTarget } from './logic'
import { InstallRun, runSshInstall, type SpawnSsh } from './runner'

/** 升失败后多久内不再自己试(人点「重试」不受它限制)。 */
export const UPGRADE_RETRY_COOLDOWN_MS = 10 * 60_000

export type SshAutoUpgrader = {
  /** 那台机器太旧:替它升级。返回 true = 此刻正在升(刚发起或早已在升);false = 冷却中 / 不归这台桌面管。 */
  request(deviceId: string, options?: { force?: boolean; desktopTooOld?: boolean }): boolean
  upgrading(deviceId: string): boolean
}

/** 一次升级跑完的样子:null = 这台桌面上没有它的 SSH 映射(不归这里升)。 */
export type RunUpgrade = (
  deviceId: string,
  onState: (state: ServerSshInstallState) => void,
) => Promise<ServerSshInstallState | null>

/** 下载那一步此刻的百分比(不知道总量 = null)。纯函数。 */
export function upgradePercent(state: ServerSshInstallState): number | null {
  const progress = state.steps.find((step) => step.id === 'download')?.progress
  if (!progress || progress.total === null || progress.total <= 0) return null
  return Math.max(0, Math.min(100, Math.floor((progress.done / progress.total) * 100)))
}

export function createSshAutoUpgrader(options: {
  run: RunUpgrade
  emit: (event: SshUpgradeEvent) => void
  /** 这台桌面自己的版本(分清「那边旧」与「这台桌面旧」)。 */
  desktopVersion?: string | null
  now?: () => number
  cooldownMs?: number
  log?: (message: string, fields?: Record<string, unknown>) => void
}): SshAutoUpgrader {
  const running = new Set<string>()
  const failedAt = new Map<string, number>()
  const now = options.now ?? Date.now
  const cooldown = options.cooldownMs ?? UPGRADE_RETRY_COOLDOWN_MS
  const log = options.log ?? (() => undefined)

  const start = (deviceId: string, desktopTooOld: boolean) => {
    running.add(deviceId)
    options.emit({ deviceId, phase: 'updating', percent: null })
    let lastPercent: number | null = null
    void options
      .run(deviceId, (state) => {
        const percent = upgradePercent(state)
        if (percent === lastPercent) return
        lastPercent = percent
        options.emit({ deviceId, phase: 'updating', percent })
      })
      .catch((error: unknown) => {
        log('ssh upgrade: crashed', { deviceId, error: error instanceof Error ? error.message : String(error) })
        return undefined
      })
      .then((final) => {
        running.delete(deviceId)
        // 升好 = 下载装了新的,或装着的已够新、把在跑的旧进程当场切了过去(service 那一步真的换了)。
        // 「装着的并不旧、在跑的也就是它」(什么也没装、什么也没换)算没升成:否则重连 → 又说太旧 → 又「升好了」,转圈。
        const finishedClean = !!final && final.finished && !final.failure
        // 什么也没换,而且是这台桌面旧(同账号另一台更新的桌面要的就是在跑的这一版,或由「这台电脑太旧」发起):
        // 不算升级失败,由这台电脑自己显示「请更新这台电脑上的咕咕」。
        const match = finishedClean ? (final.match ?? null) : null
        const stepDone = (id: string) => finishedClean && final.steps.find((s) => s.id === id)?.status === 'done'
        const nothingChanged = finishedClean && (!match || match.target === match.running) && !stepDone('download') && !stepDone('service')
        const serverIsNewer = !!match && !!options.desktopVersion && compareServerVersions(match.target, options.desktopVersion) > 0
        if (nothingChanged && (desktopTooOld || serverIsNewer)) {
          failedAt.set(deviceId, now())
          log('ssh upgrade: desktop is the older side', { deviceId, target: match?.target ?? null, desktop: options.desktopVersion ?? null })
          options.emit({ deviceId, phase: 'desktopTooOld' })
          return
        }
        const downloaded = stepDone('download')
        // 「换了」是 match-version 亲眼看到这个账号跑上了那一版,不会是空转。
        const ok = downloaded || stepDone('service')
        if (ok) {
          failedAt.delete(deviceId)
          log('ssh upgrade: done', {
            deviceId,
            via: downloaded ? 'download' : 'switch',
            version: final?.steps.find((s) => s.id === 'download')?.version ?? null,
          })
        } else {
          failedAt.set(deviceId, now())
          log('ssh upgrade: failed', {
            deviceId,
            step: final?.failure?.step ?? null,
            reason: final === null ? 'unmapped' : (final?.failure?.reason ?? (final ? 'notOutdated' : 'unknown')),
            detail: final?.failure?.detail ?? null,
          })
        }
        // 那台机器上的 server 老到不认得 match-version:没法自动更新,把重装命令带给界面(runner.ts)。
        const reinstall = final?.failure?.reason === 'serverTooOld' ? final.failure.detail : undefined
        options.emit({ deviceId, phase: ok ? 'done' : 'failed', ...(reinstall ? { reinstall } : {}) })
      })
  }

  return {
    request(deviceId, requestOptions) {
      if (running.has(deviceId)) return true
      const failed = failedAt.get(deviceId)
      if (!requestOptions?.force && failed !== undefined && now() - failed < cooldown) return false
      start(deviceId, requestOptions?.desktopTooOld === true)
      return true
    },
    upgrading: (deviceId) => running.has(deviceId),
  }
}

/**
 * 真的升:这台机器那条共享连接(终端、设备连接都骑在上面)上跑 upgrade 模式的装机流程。
 * 那台机器上不了网时同样由本机下好传过去(与添加时同一条路)。
 */
export function sshServerUpgradeRunner(options: {
  targetFor: (deviceId: string) => Promise<SshTarget | null>
  /** #6264 那台机器上是哪个账号、这台桌面是哪一版(换成匹配的那一版要用);拿不到就报错,❌ 整台升级。 */
  matchFor?: (deviceId: string) => Promise<NonNullable<Parameters<typeof runSshInstall>[2]['match']> | null>
  controlPath: () => string | null
  channel: 'stable' | 'beta'
  spawnSsh: SpawnSsh
}): RunUpgrade {
  return async (deviceId, onState) => {
    const target = await options.targetFor(deviceId)
    if (!target) return null
    const match = (await options.matchFor?.(deviceId).catch(() => null)) ?? null
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gugu-server-upgrade-'))
    const controlPath = options.controlPath()
    const run = new InstallRun(crypto.randomUUID(), target.display, onState)
    try {
      return await runSshInstall(target, run, {
        mode: 'upgrade',
        spawnSsh: options.spawnSsh,
        // upgrade 模式不登录,用不到凭证。
        mintGrant: async () => ({ error: 'grantFailed' }),
        desktopDownload: (request) => downloadServerOnDesktop({ ...request, dir }),
        currentUserId: async () => null,
        controlPath,
        ...(controlPath ? { controlPersist: SHARED_CONTROL_PERSIST } : {}),
        downloadBase: serverDownloadBase(),
        customDownloadBase: Boolean(process.env.GUGU_SERVER_DOWNLOAD_BASE?.trim()),
        channel: options.channel,
        signal: new AbortController().signal,
        ...(match ? { match } : {}),
      })
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
