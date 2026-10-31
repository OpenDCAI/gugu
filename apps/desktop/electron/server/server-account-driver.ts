/**
 * #6264 守护进程这一侧:把每个账号的状态机(server-account-machine.ts)接到真实世界。
 * 每轮对账(3 秒)为每个账号收一次事实、喂一个 tick;状态机给出的副作用在这里执行,执行结果再作为事件喂回去。
 * 状态只在状态机里;这里只记着进行中的副作用(装包 / 试跑)。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pickTargetVersion, readDesktopReports, readVersionSwitchRequest, VERSION_SWITCH_FILE } from '@gugu/core/cloud/serverDesktopVersions'
import { incomingPackage, readVersionPin, versionBinary, touchVersion, writeVersionPin, VERSION_PIN_FILE } from './server-account-versions'
import { activityProof, accountDataDir, type ServerAccount } from './server-layout'
import type { ServerVersionLifecycle } from './server-version-lifecycle'
import { AccountBootRejectedError } from './server-version-lifecycle'
import type { SupervisorLog } from './server-supervisor'
import {
  INITIAL_ACCOUNT_STATE,
  readAccountState,
  serializeAccountState,
  step,
  writeAccountState,
  type AccountEffect,
  type AccountEvent,
  type AccountState,
  type ActivityProof,
  type ChildState,
} from './server-account-machine'
import { DownloadSiteUnreachableError, fetchVersionManifest, parseManifest, stageVersion, VersionNotPublishedError } from './server-updater'

type Layout = { home: string; versions: string; version: string }
export type AccountChild = { pid: number | undefined; startedAt: number; restarting: boolean }

export function createAccountDriver(options: {
  layout: Layout
  lifecycle: ServerVersionLifecycle
  followSupervisor: boolean
  log: SupervisorLog
  child: (userId: string) => AccountChild | undefined
  /** 这次守护进程启动后起过这个账号没有(没起过 = cold:切 pin 不打断任何东西)。 */
  started: (userId: string) => boolean
  restart: (userId: string) => void
  now?: () => number
}) {
  const { layout, lifecycle, log } = options
  const now = options.now ?? Date.now
  const machines = new Map<string, AccountState>()
  const written = new Map<string, { text: string; at: number }>()
  /** 进行中的副作用(装包 / 试跑):启动时等第一轮的结论,冷启动才从对的那一版起。 */
  const inFlight = new Set<Promise<unknown>>()
  const track = (work: Promise<unknown>): void => { inFlight.add(work); void work.finally(() => inFlight.delete(work)) }

  const load = (userId: string): AccountState => {
    const known = machines.get(userId)
    if (known) return known
    const dataDir = accountDataDir(userId)
    // 旧布局只有 server-version.json:第一次读到就并进状态文件;之后它只是状态的投影(见 persist)。
    const legacy = readVersionPin(dataDir)
    const loaded = readAccountState(dataDir) ?? { ...INITIAL_ACCOUNT_STATE, version: legacy?.version ?? null }
    machines.set(userId, loaded)
    return loaded
  }
  const persist = (userId: string, state: AccountState): void => {
    machines.set(userId, state)
    const text = serializeAccountState(state, 0)
    const last = written.get(userId)
    // 内容没变就一分钟续写一次:读侧(设备行)据此知道守护进程还在。
    if (last?.text === text && now() - last.at < 60_000) return
    const dataDir = accountDataDir(userId)
    writeAccountState(dataDir, state, now())
    written.set(userId, { text, at: now() })
    // 老读者的投影:上一版守护进程派出的升级看门狗(换版窗口里跑的正是旧代码)按这份 pin 判「这个账号该不该跑新版本」。
    const pin = readVersionPin(dataDir)
    if (!state.version) fs.rmSync(path.join(dataDir, VERSION_PIN_FILE), { force: true })
    else if (pin?.version !== state.version || pin.previous !== state.previous) writeVersionPin(dataDir, { version: state.version, previous: state.previous, at: now() })
  }

  const childState = (userId: string): ChildState => {
    const child = options.child(userId)
    return child ? (child.restarting ? 'restarting' : 'running') : options.started(userId) ? 'restarting' : 'none'
  }
  const proofOf = (account: ServerAccount): ActivityProof => {
    const child = options.child(account.userId)
    if (!child) return options.started(account.userId) ? 'unverified' : 'cold'
    if (child.restarting) return 'unverified'
    return activityProof(account.dataDir, now(), child)
  }
  const installed = (version: string): boolean => fs.existsSync(versionBinary(layout.versions, version))

  const stagePackage = async (version: string): Promise<void> => {
    if (installed(version)) return
    // 受控云电脑的包由控制器放进来:缺了是装坏了,❌ 去下载。
    if (options.followSupervisor) throw new Error(`守护进程的包不完整:${version}`)
    const incoming = incomingPackage(layout.versions, version)
    if (!fs.existsSync(incoming.manifest)) return void (await stageVersion(layout, await fetchVersionManifest(layout.home, version)))
    try {
      const manifest = parseManifest(fs.readFileSync(incoming.manifest, 'utf8'))
      if (manifest.version !== version) throw new Error(`放进来的包是 ${manifest.version},要装的是 ${version}`)
      await stageVersion(layout, manifest, incoming.archive)
    } finally {
      fs.rmSync(incoming.archive, { force: true })
      fs.rmSync(incoming.manifest, { force: true })
    }
  }

  const drive = (account: ServerAccount, event: AccountEvent): void => {
    const { state, effects } = step(load(account.userId), event)
    persist(account.userId, state)
    for (const effect of effects) run(account, effect)
  }
  const targetOf = (account: ServerAccount, current: string): string => {
    if (options.followSupervisor) return layout.version
    const request = readVersionSwitchRequest(account.dataDir, now())
    const reports = readDesktopReports(account.dataDir)
    // 没有一台桌面报过版本:就留在现在这一版。
    return (request?.confirmed ? request.target : undefined) ?? pickTargetVersion(reports, now()) ?? (Object.keys(reports).length ? layout.version : current)
  }

  const run = (account: ServerAccount, effect: AccountEffect): void => {
    const userId = account.userId
    switch (effect.type) {
      case 'log':
        log[effect.level](effect.message, { account: userId, ...effect.fields })
        return
      case 'consumeRequest':
        fs.rmSync(path.join(account.dataDir, VERSION_SWITCH_FILE), { force: true })
        return
      case 'restart':
        options.restart(userId)
        return
      case 'stage':
        track(lifecycle.stage(effect.version, () => stagePackage(effect.version)).then(
          () => {
            touchVersion(layout.versions, effect.version)
            drive(account, { type: 'staged', now: now(), version: effect.version })
          },
          (error: unknown) => drive(account, {
            type: 'stageFailed',
            now: now(),
            version: effect.version,
            cause: error instanceof AccountBootRejectedError ? 'boot' : error instanceof DownloadSiteUnreachableError ? 'unreachable' : 'install',
            notPublished: error instanceof VersionNotPublishedError,
          }),
        ))
        return
    }
  }

  return {
    /** 这个账号该从哪一版的目录起;null = 用守护进程自己这一版;'none' = 现在没有能起的版本。 */
    binaryFor(userId: string): { binary: string; version: string } | null | 'none' {
      const state = load(userId)
      const version = state.version
      const pinned = version && version !== layout.version && installed(version) ? { binary: versionBinary(layout.versions, version), version } : null
      // 受控云电脑:守护进程自己的包还没通过账号试跑 ⇒ 等结论,❌ 先起旧包再打断它;没通过 ⇒ 留在能用的上一版,没有就不起。
      if (options.followSupervisor && !lifecycle.ready(layout.version)) return state.phase.kind === 'failed' ? (pinned ?? 'none') : 'none'
      return pinned
    },
    tick(accounts: readonly ServerAccount[]): void {
      for (const account of accounts) {
        const state = load(account.userId)
        const current = state.version ?? layout.version
        const target = targetOf(account, current)
        drive(account, {
          type: 'tick',
          now: now(),
          supervisor: layout.version,
          managed: options.followSupervisor,
          target,
          ready: installed(target) && lifecycle.ready(target),
          request: readVersionSwitchRequest(account.dataDir, now()),
          proof: proofOf(account),
          child: childState(account.userId),
        })
      }
    },
    /** 等眼下进行中的副作用都有了结论。 */
    async settled(): Promise<void> {
      while (inFlight.size) await Promise.allSettled([...inFlight])
    },
    childExited(account: ServerAccount, quick: boolean): void {
      drive(account, { type: 'childExited', now: now(), quick })
    },
    proofOf,
    /** 各账号在用 / 记着的版本(清旧版本时留着)。 */
    inUse(): string[] {
      return [...machines.values()].flatMap((state) => [state.version, state.previous,
        ...(state.phase.kind === 'staging' ? [state.phase.target] : [])])
        .filter((version): version is string => !!version)
    },
  }
}
