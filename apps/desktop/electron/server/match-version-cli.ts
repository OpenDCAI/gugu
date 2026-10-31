/**
 * `gugu-server match-version`(#6264 远程 SSH 的桌面发现版本对不上时经 SSH 调,见 ssh-install/runner.ts 的 upgrade 模式):
 *
 *   match-version --account <id> --desktop <桌面 id> --version <版本> [--protocol <n>]
 *       记下这台桌面是哪一版,打出这个账号的目标版本(同一账号几台桌面取最新)、此刻在跑哪一版、目标装没装。
 *   match-version --account <id> --apply <版本> [--now]
 *       请守护进程把**这一个账号**换到这一版,等它真的换过去再返回。有 agent 在跑时守护进程等它空闲,这里当场退 8;
 *       `--now` = 人点了「现在重启更新」,有 agent 在跑也当场换。没装就由守护进程自己装(下载,或用桌面经 SSH
 *       放进 `versions/.incoming/` 的包,见 server-account-driver.ts)—— 装的只有它一个,桌面 ❌ 再装一份。
 *
 * 标准输出上机器可读的一行:`MATCH_MARK key=value …`。
 * 退出码:0 成;2 用法;3 守护进程没在跑;4 等不到换过去;6 安装/试跑失败、请求被替代或受控云电脑拒绝;8 有 agent 在跑、等空闲再换;
 * 7 它连不上下载站(要桌面把包的字节放进 `versions/.incoming/` 再来一次,见 ssh-install/runner.ts)。
 * ⚠️ 只在 CLI 里跑:不碰 electron、不加载主进程。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  isServerVersion,
  pickTargetVersion,
  recordDesktopReport,
  requestVersionSwitch,
} from '@gugu/core/cloud/serverDesktopVersions'
import { MATCH_MARK, versionBinary } from './server-account-versions'
import { pickAttachAccount } from './account-call'
import { listAccounts, type ServerAccount } from './server-layout'
import { readAccountState, type AccountState, type Outcome } from './server-account-machine'

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
  /** 受控云电脑的守护进程(从它的进程环境读)跑的那一版;普通 SSH = null。账号只跟随它。 */
  managedSupervisorVersion?: () => Promise<string | null> | string | null
  exists?: (file: string) => boolean
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
  const running = () => deps.runningVersion(account) ?? readAccountState(account.dataDir)?.version ?? null

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
  // 受控云电脑上账号只跟随守护进程的包:换到别的版本永远不会发生,当场说,❌ 干等到超时。
  const managed = (await deps.managedSupervisorVersion?.()) ?? null
  if (managed && managed !== parsed.version) {
    err(`受控云电脑:账号只跟随守护进程的包 ${managed},不能换到 ${parsed.version}`)
    return 6
  }
  const requestedAt = now()
  requestVersionSwitch(account.dataDir, `desktop asked to switch to ${parsed.version}`, requestedAt, parsed.now, parsed.version)
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  // 没装的要先下载(上百 MB),所以等得比只换版久。
  const waitMs = deps.waitMs ?? 10 * 60_000
  const deadline = now() + waitMs
  // 结论只有一个来源:守护进程的状态机对「这一次请求」(按请求时刻认)写下的 lastOutcome。
  let state = readAccountState(account.dataDir)
  while (now() < deadline) {
    state = readAccountState(account.dataDir)
    const outcome = state?.lastOutcome
    if (state && outcome && outcome.request === requestedAt) {
      const answer = answerFor(parsed, state, outcome)
      if (answer.rc === 0) out(answer.text)
      else if (answer.rc !== null) err(answer.text)
      if (answer.rc !== null) return answer.rc
    }
    await sleep(500)
  }
  err(`等了 ${Math.round(waitMs / 1000)} 秒,这个账号还在跑 ${state ? currentText(state) : '(没在跑)'}`)
  return 4
}

/** 这个账号此刻在跑什么,照守护进程记下的子进程状态说。 */
export function currentText(state: AccountState): string {
  if (state.child === 'restarting') return '(正在重启)'
  if (state.child === 'none') return state.phase.kind === 'failed' || state.phase.kind === 'staging' ? '(没有能启动的版本,未启动)' : '(没在跑)'
  return state.version ?? state.supervisor ?? '(守护进程那一版)'
}

function answerFor(parsed: { account: string; version: string; now: boolean }, state: AccountState, outcome: Outcome): { rc: number | null; text: string } {
  const current = currentText(state)
  const v = parsed.version
  switch (outcome.kind) {
    case 'switched':
      return outcome.target === v
        ? { rc: 0, text: formatMatchLine({ switched: v }) }
        : { rc: 6, text: `换版请求 ${v} 已被守护进程改为 ${outcome.target},这个账号当前版本 ${current}` }
    case 'rolledBack':
      return { rc: 6, text: `换版请求 ${outcome.bad} 启动失败，已回滚到 ${outcome.back ?? state.supervisor ?? '守护进程那一版'}，这个账号当前版本 ${current}` }
    case 'failed':
    case 'refused':
      if (outcome.cause === 'unreachable') return { rc: 7, text: `这台机器连不上下载站,装不了 ${outcome.target}:要把包传过来` }
      if (outcome.cause === 'install') return { rc: 6, text: `这台机器装 ${outcome.target} 失败了(原因在咕咕 server 的日志里),这个账号还在跑 ${current}` }
      // 确认重启就是这一版的最后一招:它还起不来就请人等新版本,❌ 再叫人 --now 一次。
      return outcome.kind === 'failed' || parsed.now
        ? { rc: 6, text: `${outcome.target} 在这台机器上仍然启动失败,没有换过去;请等待新版本。这个账号当前版本 ${current}` }
        : { rc: 6, text: `${outcome.target} 在这台机器上启动失败过,冷却中不再自动尝试;检查后显式确认现在重启:match-version --account ${parsed.account} --apply ${outcome.target} --now。这个账号当前版本 ${current}` }
    case 'waiting':
      // 装好了、要人确认才换:当场说,桌面问人「现在重启更新 / 稍后」,❌ 干等 10 分钟。
      if (parsed.now) return { rc: null, text: '' }
      return { rc: 8, text: `${outcome.target} 已装好;为了不打断任务不会自己重启,检查任务后显式确认现在重启:match-version --account ${parsed.account} --apply ${outcome.target} --now` }
  }
}
