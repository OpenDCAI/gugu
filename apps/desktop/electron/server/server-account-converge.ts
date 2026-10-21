/**
 * #6264 守护进程这一侧:让每个账号跑和自己桌面匹配的那一版(规则见 server-account-versions.ts)。
 *
 * 由守护进程每一轮对账(3 秒)调一次 converge:只读每个账号目录里的两个小文件(桌面报告、换版请求),
 * ❌ 访问网络、❌ 读设备表;真要下载某一版时才起一次下载(同一版同时只下一份)。
 * 换版 = 记下这个账号跑哪一版(server-version.json)→ 只结束这一个账号的进程 → 对账把它从新版本的目录拉起来。
 */
import fs from 'node:fs'
import { readDesktopReports, readVersionSwitchRequest, VERSION_SWITCH_FILE } from '@gugu/core/cloud/serverDesktopVersions'
import path from 'node:path'
import {
  ACCOUNT_VERSION_FILE,
  incomingPackage,
  pinnedVersionToRun,
  planAccountVersion,
  pruneVersions,
  readAccountVersionPin,
  touchVersion,
  versionBinary,
  writeAccountVersionPin,
} from './server-account-versions'
import { accountDataDir, accountIsBusy, listAccounts, type ServerAccount } from './server-layout'
import type { SupervisorLog } from './server-supervisor'
import { addBadVersion, readBadVersions } from './server-upgrade-guard'
import {
  createServerUpdateStateWriter,
  DownloadSiteUnreachableError,
  fetchVersionManifest,
  parseManifest,
  stageVersion,
  VersionNotPublishedError,
  type ServerUpdateStateWriter,
} from './server-updater'

/** 某一版在这台机器上失败过(下载 / 试跑失败、换过去起不来)之后多久不再自己试。 */
export const VERSION_FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000
/**
 * 下载站上还没有这一版(server 包比桌面包晚发):不算失败,设备行照旧「正在下载」,隔这么久再取一次清单。
 * 5 分钟:和拿不到额度时最慢的重试间隔同一量级;一台机器一小时最多取 12 次几十字节的清单。
 */
export const VERSION_NOT_PUBLISHED_RETRY_MS = 5 * 60 * 1000
/** 换过去之后这么久里秒退了几次就算「这一版在这里起不来」。 */
const QUICK_EXITS_TO_ROLL_BACK = 3
const ROLLBACK_WINDOW_MS = 10 * 60 * 1000

type Layout = { home: string; versions: string; version: string }

export type AccountVersionConverger = {
  /** 这个账号该从哪一版的目录起;null = 用守护进程自己这一版。 */
  binaryFor(userId: string): { binary: string; version: string } | null
  converge(accounts: readonly ServerAccount[]): void
  /** 这个账号的进程起来没多久就退了。 */
  quickExit(userId: string, version: string | null): void
  /** 各账号在用 / 记着的版本 + 守护进程自己的(清旧版本时一律留着)。 */
  inUse(): string[]
}

export function createAccountVersionConverger(options: {
  layout: Layout | null
  log: SupervisorLog
  /** 这个账号的进程此刻跑的哪一版;没在跑 = undefined。 */
  running: (userId: string) => string | null | undefined
  /** 只结束这个账号的进程(守护进程下一轮对账会按新版本拉起它)。 */
  restart: (userId: string) => void
  now?: () => number
  busy?: (dataDir: string) => boolean
  /**
   * 装某一版(缺省:按那一版的清单下载、校验、试跑,见 server-updater.stageVersion)。连不上下载站时记下 'unreachable',
   * 桌面经 SSH 把包和清单行放进 `versions/.incoming/` 再请它换,就装那一份(❌ 下载);装完删掉。换版装东西的只有这里一个。
   */
  stage?: (version: string) => Promise<void>
  stateWriter?: (account: ServerAccount) => ServerUpdateStateWriter
  exists?: (file: string) => boolean
}): AccountVersionConverger {
  const { layout, log } = options
  const now = options.now ?? Date.now
  const exists = options.exists ?? ((file: string) => fs.existsSync(file))
  const busy = options.busy ?? ((dataDir: string) => accountIsBusy(dataDir))
  const makeWriter = options.stateWriter ?? ((account: ServerAccount) => createServerUpdateStateWriter(account.dir))
  /**
   * 设备行上「正在下载 / 空闲时自动更新」那一格(随这个账号的心跳报,见 core/cloud/deviceHostInfo.ts)。
   * 同一句一分钟内不重写:对账每 3 秒一轮,❌ 每轮都写一次盘。
   */
  const written = new Map<string, { key: string; at: number }>()
  /** 这个进程已经清过一次的账号:上一个守护进程留下的那一格(比如它记的「更新没成功」)也要清,❌ 只清自己写过的。 */
  const clearedOnce = new Set<string>()
  const stateOf = (account: ServerAccount): ServerUpdateStateWriter => {
    const writer = makeWriter(account)
    return {
      set(state, version, reason) {
        const key = `${state}:${version}:${reason ?? ''}`
        const last = written.get(account.userId)
        if (last?.key === key && now() - last.at < 60_000) return
        written.set(account.userId, { key, at: now() })
        writer.set(state, version, reason)
      },
      clear() {
        if (!written.has(account.userId) && clearedOnce.has(account.userId)) return
        written.delete(account.userId)
        clearedOnce.add(account.userId)
        writer.clear()
      },
    }
  }
  const stage =
    options.stage ??
    (async (version: string) => {
      if (!layout) throw new Error('不是经 install.sh 装的布局')
      const incoming = incomingPackage(layout.versions, version)
      if (!exists(incoming.manifest)) return void (await stageVersion(layout, await fetchVersionManifest(layout.home, version)))
      try {
        const manifest = parseManifest(fs.readFileSync(incoming.manifest, 'utf8'))
        if (manifest.version !== version) throw new Error(`放进来的包是 ${manifest.version},要装的是 ${version}`)
        await stageVersion(layout, manifest, incoming.archive)
      } finally {
        fs.rmSync(incoming.archive, { force: true })
        fs.rmSync(incoming.manifest, { force: true })
      }
    })
  /** 正在装的版本(Infinity),或下载站上还没有、到这个时刻再试的版本。 */
  const staging = new Map<string, number>()
  const failedAt = new Map<string, number>()
  const switches = new Map<string, { version: string; previous: string | null; at: number; quickExits: number }>()
  /** 刚请它换过去、旧进程还在收尾的账号:等它退干净再说,❌ 每一轮都再结束一次。 */
  const pending = new Map<string, string>()

  const installed = (version: string): boolean => !!layout && exists(versionBinary(layout.versions, version))
  /**
   * 失败后冷却中;人点了「重试」(比失败更晚的换版请求,见 VERSION_RETRY_RPC)就不算。
   * 两种失败：装不上(下载 / 试跑失败,可能只是网断了,记在内存里)与起不来(盘上 bad-versions.json 那本账，
   * 看门狗退回来的与本账号换过去秒退的同记一处，守护进程追通道时也跳过它)。
   */
  const failed = (version: string, request: { at: number } | null = null): boolean => {
    const at = Math.max(failedAt.get(version) ?? -Infinity, (layout && readBadVersions(layout.home)[version]) ?? -Infinity)
    return at > -Infinity && now() - at < VERSION_FAILURE_COOLDOWN_MS && !(request && request.at > at)
  }

  const binaryFor = (userId: string): { binary: string; version: string } | null => {
    if (!layout) return null
    const version = pinnedVersionToRun(readAccountVersionPin(accountDataDir(userId)), layout.version, installed)
    return version ? { binary: versionBinary(layout.versions, version), version } : null
  }

  const inUse = (): string[] => {
    const versions = new Set<string>()
    if (layout) versions.add(layout.version)
    for (const account of listAccounts()) {
      const pin = readAccountVersionPin(account.dataDir)
      if (pin) versions.add(pin.version)
      const running = options.running(account.userId)
      if (running) versions.add(running)
    }
    return [...versions]
  }

  const startStaging = (account: ServerAccount, version: string, state: ServerUpdateStateWriter): void => {
    state.set('downloading', version)
    if (now() < (staging.get(version) ?? 0)) return
    staging.set(version, Infinity)
    log.info('这个账号的桌面是另一版,后台装上那一版', { account: account.userId, version })
    void stage(version)
      .then(() => {
        if (layout) touchVersion(layout.versions, version)
        log.info('那一版装好了', { version })
        staging.delete(version)
      })
      .catch((error: unknown) => {
        if (error instanceof VersionNotPublishedError) {
          staging.set(version, now() + VERSION_NOT_PUBLISHED_RETRY_MS)
          log.info('下载站上还没有那一版,过几分钟再看', { version, error: error.message })
          return
        }
        staging.delete(version)
        failedAt.set(version, now())
        state.set('failed', version, error instanceof DownloadSiteUnreachableError ? 'unreachable' : undefined)
        log.warn('装那一版失败,过一阵再试', { version, error: error instanceof Error ? error.message : String(error) })
      })
  }

  const switchTo = (account: ServerAccount, version: string, from: string | null, urgent: boolean): void => {
    if (!layout) return
    writeAccountVersionPin(account.dataDir, { version, previous: from, at: now() })
    touchVersion(layout.versions, version)
    fs.rmSync(path.join(account.dataDir, VERSION_SWITCH_FILE), { force: true })
    switches.set(account.userId, { version, previous: from, at: now(), quickExits: 0 })
    pending.set(account.userId, version)
    log.info('这个账号换到和桌面匹配的那一版', { account: account.userId, from, to: version, urgent })
    if (options.running(account.userId) !== undefined) options.restart(account.userId)
    try {
      const removed = pruneVersions(layout.versions, [...inUse(), version])
      if (removed.length) log.info('清掉没人用的旧版本', { removed })
    } catch (error) {
      log.warn('清旧版本失败', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    binaryFor,
    inUse,
    converge(accounts) {
      if (!layout) return
      for (const account of accounts) {
        const reports = readDesktopReports(account.dataDir)
        if (Object.keys(reports).length === 0) continue
        const current = options.running(account.userId)
        const waiting = pending.get(account.userId)
        if (waiting && current !== undefined && current !== waiting) continue
        pending.delete(account.userId)
        const request = readVersionSwitchRequest(account.dataDir, now())
        // 没在跑(正在退避重启):它下次起来用的那一版。
        const effective = current !== undefined ? current : (binaryFor(account.userId)?.version ?? layout.version)
        const state = stateOf(account)
        const plan = planAccountVersion({
          reports,
          now: now(),
          running: effective,
          switchRequested: request !== null,
          installed,
          busy: current !== undefined && busy(account.dataDir),
          failed: (version) => failed(version, request),
          fallback: layout.version,
        })
        switch (plan.kind) {
          case 'none':
            if (plan.clearSwitchRequest && request) fs.rmSync(path.join(account.dataDir, VERSION_SWITCH_FILE), { force: true })
            state.clear()
            break
          case 'failed':
            // 设备行「更新没成功 · 重试」(随这个账号的心跳报;守护进程每分钟续写,它不在了自然过期)。
            state.set('failed', plan.version)
            break
          case 'stage':
            startStaging(account, plan.version, state)
            break
          case 'wait-idle':
            // 装好了、等这个账号空闲:设备行上说「有新版本,空闲时自动更新」(每轮续写,守护进程没了它自己过期)。
            state.set('ready', plan.version)
            break
          case 'switch':
            state.clear()
            switchTo(account, plan.version, effective, plan.urgent)
            break
        }
      }
    },
    quickExit(userId, version) {
      const last = switches.get(userId)
      if (!last || last.version !== version || now() - last.at > ROLLBACK_WINDOW_MS) return
      last.quickExits += 1
      if (last.quickExits < QUICK_EXITS_TO_ROLL_BACK) return
      switches.delete(userId)
      if (layout) addBadVersion(layout.home, last.version, now())
      const dataDir = accountDataDir(userId)
      if (last.previous) writeAccountVersionPin(dataDir, { version: last.previous, previous: null, at: now() })
      else fs.rmSync(path.join(dataDir, ACCOUNT_VERSION_FILE), { force: true })
      log.warn('换过去的那一版在这台机器上起不来,退回原来那一版', { account: userId, version: last.version, back: last.previous })
    },
  }
}
