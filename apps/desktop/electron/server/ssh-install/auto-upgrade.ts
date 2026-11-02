/** SSH upgrades reuse prepared server controls, or the existing whole-installation installer. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerSshInstallState } from '../../../src/lib/serverSshInstall'
import type { SshUpgradeEvent } from '../../../src/lib/sshLink'
import { VERSION_RESTART_RPC, VERSION_RETRY_RPC, LEGACY_VERSION_RETRY_RPC, serverSupportsConfirmedRestart } from '@gugu/core/cloud/serverMachineHealth'
import type { DeviceCapabilities } from '@gugu/core/shared/types/chat'
import type { DeviceRpcRequester } from '@gugu/core/cloud/deviceRpcRequester'
import { canRestartServerUpdate } from '../../../src/lib/deviceRowModel'
import { serverDownloadBase } from '../server-download'
import { downloadServerOnDesktop } from './desktop-download'
import { SHARED_CONTROL_PERSIST, type SshTarget } from './logic'
import { InstallRun, runSshInstall, type SpawnSsh } from './runner'

/** 升失败后多久内不再自己试(人点「重试」不受它限制)。 */
export const UPGRADE_RETRY_COOLDOWN_MS = 10 * 60_000

export type SshAutoUpgrader = {
  /** 那台机器太旧:替它升级。返回 true = 此刻正在升(刚发起或早已在升);false = 冷却中 / 不归这台桌面管。 */
  /** `now` = 人点了「现在重启更新」:那个账号有 agent 在跑也当场换(否则那台机器等它空闲,这里报 waitingIdle)。 */
  request(deviceId: string, options?: { force?: boolean; desktopTooOld?: boolean; now?: boolean }): boolean
  upgrading(deviceId: string): boolean
}

/** 一次升级跑完的样子:null = 这台桌面上没有它的 SSH 映射(不归这里升)。 */
export type RunUpgrade = (
  deviceId: string,
  onState: (state: ServerSshInstallState) => void,
  options?: { now?: boolean },
) => Promise<(ServerSshInstallState & { unconfirmed?: { request: number; reportedVersion: string | null; update: DeviceCapabilities['server_update'] | null } }) | null>

/** 下载那一步此刻的百分比(不知道总量 = null)。纯函数。 */
export function upgradePercent(state: ServerSshInstallState): number | null {
  const progress = state.steps.find((step) => step.id === 'download')?.progress
  if (!progress || progress.total === null || progress.total <= 0) return null
  return Math.max(0, Math.min(100, Math.floor((progress.done / progress.total) * 100)))
}

export function createSshAutoUpgrader(options: {
  run: RunUpgrade
  emit: (event: SshUpgradeEvent) => void
  now?: () => number
  cooldownMs?: number
  log?: (message: string, fields?: Record<string, unknown>) => void
}): SshAutoUpgrader {
  const running = new Set<string>()
  const failedAt = new Map<string, number>()
  const now = options.now ?? Date.now
  const cooldown = options.cooldownMs ?? UPGRADE_RETRY_COOLDOWN_MS
  const log = options.log ?? (() => undefined)

  const start = (deviceId: string, applyNow: boolean) => {
    running.add(deviceId)
    options.emit({ deviceId, phase: 'updating', percent: null })
    let lastPercent: number | null = null
    void options
      .run(deviceId, (state) => {
        const percent = upgradePercent(state)
        if (percent === lastPercent) return
        lastPercent = percent
        options.emit({ deviceId, phase: 'updating', percent })
      }, { now: applyNow })
      .catch((error: unknown) => {
        log('ssh upgrade: crashed', { deviceId, error: error instanceof Error ? error.message : String(error) })
        return undefined
      })
      .then((final) => {
        running.delete(deviceId)
        if (final?.unconfirmed) {
          // Stop this click's observer without inventing a terminal host outcome or reconnecting.
          failedAt.set(deviceId, now())
          log('ssh restart remains unconfirmed', { deviceId, ...final.unconfirmed })
          options.emit({ deviceId, phase: 'unconfirmed', ...final.unconfirmed })
          return
        }
        // 升好 = 下载装了新的,或装着的已够新、把在跑的旧进程当场切了过去(service 那一步真的换了)。
        // 「装着的并不旧、在跑的也就是它」(什么也没装、什么也没换)算没升成:否则重连 → 又说太旧 → 又「升好了」,转圈。
        const finishedClean = !!final && final.finished && !final.failure
        const stepDone = (id: string) => finishedClean && final.steps.find(s => s.id === id)?.status === 'done'
        // 那个账号有 agent 在跑:那台机器装好了、等它空闲再换(到时自己换,不用这台桌面再来)。问人「现在重启更新 / 稍后」;
        // 记进冷却,❌ 每次重连都再请一遍。
        if (final?.failure?.reason === 'agentsRunning') {
          failedAt.set(deviceId, now())
          log('ssh upgrade: waiting for agents to finish', { deviceId })
          options.emit({ deviceId, phase: 'waitingIdle' })
          return
        }
        const downloaded = stepDone('download')
        // Prepared switches finish only after their request-correlated heartbeat result.
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
        // Preserve installer failure details for the existing prompt.
        const reinstall = final?.failure?.reason === 'serverTooOld' ? final.failure.detail : undefined
        options.emit({ deviceId, phase: ok ? 'done' : 'failed', ...(reinstall ? { reinstall } : {}) })
      })
  }

  return {
    request(deviceId, requestOptions) {
      if (requestOptions?.desktopTooOld) { options.emit({ deviceId, phase: 'desktopTooOld' }); return false }
      if (running.has(deviceId)) return true
      const failed = failedAt.get(deviceId)
      if (!requestOptions?.force && failed !== undefined && now() - failed < cooldown) return false
      start(deviceId, requestOptions?.now === true)
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
  currentUserId: () => Promise<string | null>
  readCapabilities: (deviceId: string) => Promise<DeviceCapabilities | null>
  call: DeviceRpcRequester['call']
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  controlPath: () => string | null
  channel: 'stable' | 'beta'
  spawnSsh: SpawnSsh
}): RunUpgrade {
  return async (deviceId, onState, runOptions) => {
    const target = await options.targetFor(deviceId)
    if (!target) return null
    const run = new InstallRun(crypto.randomUUID(), target.display, onState)
    const capabilities = await options.readCapabilities(deviceId)
    const update = capabilities?.server_update
    if (update?.state === 'ready') {
      const fail = (reason: 'agentsRunning' | 'serviceFailed', detail: string) => {
        run.setStep('service', { status: 'failed' })
        run.update(draft => { draft.failure = { step: 'service', reason, detail }; draft.finished = true })
        return run.snapshot()
      }
      const confirmed = runOptions?.now === true
      if (confirmed && !canRestartServerUpdate(update, capabilities!)) return fail('agentsRunning', 'This server must wait for idle before updating')
      const modern = serverSupportsConfirmedRestart(capabilities)
      const reply = await options.call(deviceId,
        confirmed ? modern ? VERSION_RESTART_RPC : LEGACY_VERSION_RETRY_RPC : VERSION_RETRY_RPC,
        confirmed && modern ? { version: update.version, confirmed: true } : {}, { timeoutMs: 15_000 })
      const receipt = reply.result as { requested?: unknown; at?: unknown } | undefined
      if (reply.error || receipt?.requested !== true) return fail('serviceFailed', reply.error?.message ?? 'Server did not acknowledge the update request')
      if (!confirmed || !modern) {
        return fail('agentsRunning', 'The server was asked to update when idle; no confirmed restart receipt was issued')
      }
      if (typeof receipt.at !== 'number' || !Number.isFinite(receipt.at)) return fail('serviceFailed', 'Server did not provide a restart receipt')
      // Use the same request-correlated heartbeat result as the device page. An RPC acknowledgement is not a switch.
      run.setStep('service', { status: 'running', version: update.version })
      const now = options.now ?? Date.now
      const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
      const deadline = now() + 10 * 60_000
      let reported: DeviceCapabilities | null = capabilities
      while (now() < deadline) {
        reported = await options.readCapabilities(deviceId).catch(() => null)
        const outcome = reported?.server_update?.lastOutcome
        if (outcome?.request === receipt.at && outcome.kind !== 'waiting') {
          if (outcome.kind !== 'switched') return fail('serviceFailed', `Server update ${outcome.kind}`)
          run.setStep('download', { status: 'skipped', skippedBecause: 'alreadyInstalled', version: update.version })
          run.setStep('service', { status: 'done', version: update.version })
          run.setStep('login', { status: 'skipped', skippedBecause: 'alreadySignedIn' })
          run.update(draft => { draft.finished = true })
          return run.snapshot()
        }
        await sleep(2_000)
      }
      return { ...run.snapshot(), unconfirmed: { request: receipt.at, reportedVersion: reported?.app_version ?? null, update: reported?.server_update ?? null } }
    }
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gugu-server-upgrade-'))
    const controlPath = options.controlPath()
    try {
      return await runSshInstall(target, run, {
        mode: 'upgrade',
        spawnSsh: options.spawnSsh,
        // upgrade 模式不登录,用不到凭证。
        mintGrant: async () => ({ error: 'grantFailed' }),
        desktopDownload: (request) => downloadServerOnDesktop({ ...request, dir }),
        currentUserId: options.currentUserId,
        controlPath,
        ...(controlPath ? { controlPersist: SHARED_CONTROL_PERSIST } : {}),
        downloadBase: serverDownloadBase(),
        customDownloadBase: Boolean(process.env.GUGU_SERVER_DOWNLOAD_BASE?.trim()),
        channel: options.channel,
        signal: new AbortController().signal,
        ...(runOptions?.now ? { now: true } : {}),
      })
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
