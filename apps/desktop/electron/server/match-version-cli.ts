/**
 * `gugu-server match-version`(#6264 远程 SSH 的桌面发现版本对不上时经 SSH 调,见 ssh-install/runner.ts 的 upgrade 模式):
 *
 *   match-version --account <id> --desktop <桌面 id> --version <版本> [--protocol <n>]
 *       记下这台桌面是哪一版,打出这个账号的目标版本(同一账号几台桌面取最新)、此刻在跑哪一版、目标装没装。
 *   match-version --account <id> --apply <版本> [--now]
 *       请守护进程把**这一个账号**换到这一版,等它真的换过去再返回。有 agent 在跑时守护进程等它空闲,这里当场退 8;
 *       `--now` = 人点了「现在重启更新」,有 agent 在跑也当场换。没装就由守护进程自己装(下载,或用桌面经 SSH
 *       放进 `versions/.incoming/` 的包,见 server-account-converge.ts)—— 装的只有它一个,桌面 ❌ 再装一份。
 *
 * 标准输出上机器可读的一行:`MATCH_MARK key=value …`。
 * 退出码:0 成;2 用法;3 守护进程没在跑;4 等不到换过去;6 守护进程装这一版失败了;8 有 agent 在跑、等空闲再换;
 * 7 它连不上下载站(要桌面把包的字节放进 `versions/.incoming/` 再来一次,见 ssh-install/runner.ts)。
 * ⚠️ 只在 CLI 里跑:不碰 electron、不加载主进程。
 */
import fs from 'node:fs'
import path from 'node:path'
import { SERVER_UPDATE_STATE_FILE } from '@gugu/core/cloud/deviceHostInfo'
import {
  isServerVersion,
  pickTargetVersion,
  recordDesktopReport,
  requestVersionSwitch,
} from '@gugu/core/cloud/serverDesktopVersions'
import { MATCH_MARK, readAccountVersionPin, versionBinary } from './server-account-versions'
import { pickAttachAccount } from './account-call'
import { listAccounts, type ServerAccount } from './server-layout'

const ID = /^[A-Za-z0-9:_-]{1,128}$/

export type MatchArgs =
  | { mode: 'report'; account: string; desktop: string; version: string; protocol: number | null }
  | { mode: 'apply'; account: string; version: string; now: boolean }

export function parseMatchArgs(args: readonly string[]): MatchArgs | { error: string } {
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith('--')) return { error: `不认识的参数:${arg}` }
    const [key, inline] = arg.slice(2).split(/=(.*)/s)
    values.set(key!, inline ?? (key === 'now' ? '1' : (args[++i] ?? '')))
  }
  const account = values.get('account') ?? ''
  if (!ID.test(account)) return { error: '--account 后面要写账号 id' }
  const apply = values.get('apply')
  if (apply !== undefined) return isServerVersion(apply) ? { mode: 'apply', account, version: apply, now: values.has('now') } : { error: '--apply 后面要写版本号' }
  const desktop = values.get('desktop') ?? ''
  const version = values.get('version') ?? ''
  if (!ID.test(desktop) || !isServerVersion(version)) return { error: '用法:gugu-server match-version --account <id> --desktop <桌面 id> --version <版本> [--protocol <n>]' }
  const protocol = Number(values.get('protocol'))
  return { mode: 'report', account, desktop, version, protocol: Number.isInteger(protocol) && protocol > 0 ? protocol : null }
}

export function formatMatchLine(fields: Record<string, string | number | boolean | null>): string {
  return `${MATCH_MARK} ${Object.entries(fields)
    .map(([key, value]) => `${key}=${value === null ? '' : typeof value === 'boolean' ? (value ? 1 : 0) : value}`)
    .join(' ')}`
}

export type MatchDeps = {
  home: string
  accounts?: () => ServerAccount[]
  /** 这个账号此刻在跑的那一版(读它的进程);没在跑 = null。 */
  runningVersion: (account: ServerAccount) => string | null
  supervisorRunning: () => boolean
  exists?: (file: string) => boolean
  /** 这个账号的升级状态文件(守护进程写的,见 server-account-converge.ts);没有 = null。 */
  readUpdateState?: (account: ServerAccount) => string | null
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  waitMs?: number
}

export async function runMatchVersion(args: readonly string[], out: (line: string) => void, err: (line: string) => void, deps: MatchDeps): Promise<number> {
  const parsed = parseMatchArgs(args)
  if ('error' in parsed) {
    err(parsed.error)
    return 2
  }
  const account = pickAttachAccount((deps.accounts ?? listAccounts)(), parsed.account)
  if ('error' in account) {
    err(account.error)
    return 5
  }
  const versionsDir = path.join(deps.home, 'versions')
  const exists = deps.exists ?? ((file: string) => fs.existsSync(file))
  const now = deps.now ?? Date.now
  const running = () => deps.runningVersion(account) ?? readAccountVersionPin(account.dataDir)?.version ?? null

  if (parsed.mode === 'report') {
    const reports = recordDesktopReport(account.dataDir, { id: parsed.desktop, version: parsed.version, protocol: parsed.protocol }, now())
    const target = pickTargetVersion(reports, now()) ?? parsed.version
    out(formatMatchLine({ target, running: running(), installed: exists(versionBinary(versionsDir, target)), supervisor: deps.supervisorRunning() }))
    return 0
  }

  if (!deps.supervisorRunning()) {
    err('咕咕 server 没在运行:执行 gugu-server service install')
    return 3
  }
  const requestedAt = now()
  requestVersionSwitch(account.dataDir, `desktop asked to switch to ${parsed.version}`, requestedAt, parsed.now, parsed.version)
  const readState = deps.readUpdateState ?? ((a: ServerAccount) => {
    try {
      return fs.readFileSync(path.join(a.dataDir, SERVER_UPDATE_STATE_FILE), 'utf8')
    } catch {
      return null
    }
  })
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  // 没装的要先下载(上百 MB),所以等得比只换版久。
  const waitMs = deps.waitMs ?? 10 * 60_000
  const deadline = now() + waitMs
  let seen = running()
  while (now() < deadline) {
    seen = deps.runningVersion(account)
    if (seen === parsed.version) {
      out(formatMatchLine({ switched: parsed.version }))
      return 0
    }
    // 守护进程在这次请求之后记下「装这一版失败」:当场说,❌ 干等到超时。原因在它的日志里。
    const state = (() => {
      try {
        return JSON.parse(readState(account) ?? '') as { state?: unknown; version?: unknown; at?: unknown; reason?: unknown }
      } catch {
        return null
      }
    })()
    // 装好了、守护进程在等这个账号空闲(有 agent 在跑):当场说,桌面问人「现在重启更新 / 稍后」,❌ 干等 10 分钟。
    if (!parsed.now && state?.state === 'ready' && state.version === parsed.version && typeof state.at === 'number' && state.at >= requestedAt) {
      err(state.reason === 'runtime-unverified'
        ? `无法核实这个账号的任务活体，自动切换已暂停。检查任务后显式确认现在重启：match-version --account ${parsed.account} --apply ${parsed.version} --now`
        : `这个账号有任务仍附着，停止任务后会换到 ${parsed.version}；也可以检查任务后显式确认现在重启`)
      return 8
    }
    if (state?.state === 'failed' && state.version === parsed.version && typeof state.at === 'number' && state.at >= requestedAt) {
      if (state.reason === 'unreachable') {
        err(`这台机器连不上下载站,装不了 ${parsed.version}:要把包传过来`)
        return 7
      }
      err(`这台机器装 ${parsed.version} 失败了(原因在咕咕 server 的日志里),这个账号还在跑 ${seen ?? '(没在跑)'}`)
      return 6
    }
    await sleep(500)
  }
  const installed = exists(versionBinary(versionsDir, parsed.version))
  err(`等了 ${Math.round(waitMs / 1000)} 秒,这个账号还在跑 ${seen ?? '(没在跑)'}${installed ? '' : `(${parsed.version} 还没装好,装好后会自己换过去)`}`)
  return 4
}
