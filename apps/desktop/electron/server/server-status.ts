/**
 * #6264 `gugu-server status` 的两种说法:给人看的几行字,和给桌面经 SSH 读的 JSON(`--json`,夹在标记之间,
 * 用户 rc 打的字混进来也不碍事,同 attach-protocol.ts 里的标记帧)。
 *
 * 说清「这个账号为什么不在这台机器上登着」:照 VS Code Tunnels(`code tunnel status` / 断开时提示
 * `code tunnel user login`)与 Tailscale 管理台(机器标「Expired」并说「重新认证」):离线 ≠ 登录没了,
 * 后者要告诉人去哪、敲什么。纯函数,单测钉住。
 */
import { SERVER_LOGIN_ACTION } from '@gugu/core/cloud/remoteTunnel'
import { parseServerUpdateState } from '@gugu/core/cloud/deviceHostInfo'
import type { ServerAccount } from './server-layout'

export const STATUS_JSON_BEGIN = '__GUGU_STATUS_BEGIN__'
export const STATUS_JSON_END = '__GUGU_STATUS_END__'

export type StatusAccount = {
  userId: string
  email: string | null
  signedIn: boolean
  running: boolean
  /** 实际活进程的包;读不到时为 null,不拿 pin 冒充。 */
  version?: string | null
  signedOut: ServerAccount['signedOut']
}

export type StatusReport = { version: string | null; installedVersion?: string | null; supervisorVersion?: string | null; accounts: StatusAccount[] }

/** Legacy account binaries cannot relay this new reason; the supervisor's current CLI can. */
export function formatUpgradeLines(text: string | null, accounts: readonly StatusAccount[], now = Date.now()): string[] {
  const update = text ? parseServerUpdateState(text, now) : null
  if (update?.reason !== 'runtime-unverified') return []
  return [
    `自动升级 ${update.version} 已暂停：无法核实账号或目标版本的任务活体。检查任务后，明确重启到支持活体报告的版本：`,
    ...accounts.filter(account => account.signedIn).map(account =>
      `  gugu-server match-version --account ${account.userId} --apply ${update.version} --now`),
  ]
}

/** 列哪些账号:登着的,和被迫登出的(自己 logout 的不列 —— 那是他自己的选择,不用解释)。 */
export function statusAccounts(accounts: readonly ServerAccount[], running: (account: ServerAccount) => boolean, versionOf?: (account: ServerAccount) => string | null): StatusAccount[] {
  return accounts
    .filter((account) => account.signedIn || account.signedOut)
    .map((account) => ({
      userId: account.userId,
      email: account.email,
      signedIn: account.signedIn,
      running: account.signedIn && running(account),
      ...(versionOf ? { version: account.signedIn ? versionOf(account) : null } : {}),
      signedOut: account.signedIn ? null : account.signedOut,
    }))
}

export function formatStatusJson(report: StatusReport): string {
  return `\n${STATUS_JSON_BEGIN}\n${JSON.stringify(report)}\n${STATUS_JSON_END}\n`
}

export function parseStatusJson(stdout: string): StatusReport | null {
  const begin = stdout.lastIndexOf(STATUS_JSON_BEGIN)
  if (begin < 0) return null
  const end = stdout.indexOf(STATUS_JSON_END, begin)
  if (end < 0) return null
  try {
    const value = JSON.parse(stdout.slice(begin + STATUS_JSON_BEGIN.length, end).trim()) as StatusReport
    return value && Array.isArray(value.accounts) ? value : null
  } catch {
    return null
  }
}

/** 给人看的「登录的账号」那几行。 */
export function formatAccountLines(accounts: readonly StatusAccount[], pidOf: (userId: string) => number | null): string[] {
  if (accounts.length === 0) return [`登录的账号:无(${SERVER_LOGIN_ACTION})`]
  const lines = ['登录的账号:']
  for (const account of accounts) {
    const who = account.email ?? account.userId
    if (account.signedIn) {
      const pid = pidOf(account.userId)
      lines.push(`  ${who}  ${pid ? `在运行(进程 ${pid})` : '没在运行'}`)
    } else if (account.signedOut?.reason === 'removed') {
      lines.push(`  ${who}  已从账号移除(${account.signedOut.at.slice(0, 16).replace('T', ' ')}),重新登录:${SERVER_LOGIN_ACTION}`)
    } else if (account.signedOut) {
      lines.push(`  ${who}  登录已失效(${account.signedOut.at.slice(0, 16).replace('T', ' ')} 起),重新登录:${SERVER_LOGIN_ACTION}`)
    }
  }
  return lines
}
