/** Compatibility for released desktops. Selection belongs to the installation updater. */
import fs from 'node:fs'
import path from 'node:path'
import { isServerVersion } from '@gugu/core/cloud/serverDesktopVersions'
import { VERSION_RESTART_RPC } from '@gugu/core/cloud/serverMachineHealth'
import type { DeviceRpcResponse } from '@gugu/core/cloud/deviceRpcProtocol'
import { MATCH_MARK, versionBinary } from './server-account-versions'
import { callAccountProcess, pickAttachAccount } from './account-call'
import { listAccounts, type ServerAccount } from './server-layout'
import { readUpdateRecord } from './server-update-state'

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
  runningVersion: (account: ServerAccount) => string | null
  supervisorRunning: () => boolean
  call?: (account: ServerAccount, type: string, payload: unknown) => Promise<DeviceRpcResponse<unknown>>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  waitMs?: number
}

async function callUpdate(account: ServerAccount, type: string, payload: unknown): Promise<DeviceRpcResponse<unknown>> {
  const answer = await callAccountProcess(account, { type, payload }, { timeoutMs: 15_000 })
  if ('code' in answer) return { error: { code: 'unavailable', message: answer.message } }
  return JSON.parse(answer.reply.toString('utf8')) as DeviceRpcResponse<unknown>
}

export async function runMatchVersion(args: readonly string[], out: (line: string) => void, err: (line: string) => void, deps: MatchDeps): Promise<number> {
  const parsed = parseMatchArgs(args)
  if ('error' in parsed) { err(parsed.error); return 2 }
  const account = pickAttachAccount((deps.accounts ?? listAccounts)(), parsed.account)
  if ('error' in account) { err(account.error); return 5 }
  let current: string | null = null
  try {
    const directory = fs.realpathSync(path.join(deps.home, 'current'))
    if (path.dirname(directory) === fs.realpathSync(path.join(deps.home, 'versions')) && isServerVersion(path.basename(directory))) current = path.basename(directory)
  } catch { /* An unresolved current is not an installed version. */ }
  const record = readUpdateRecord(deps.home)
  const ready = record?.state === 'ready' && fs.existsSync(versionBinary(path.join(deps.home, 'versions'), record.version)) ? record.version : null
  if (parsed.mode === 'report') {
    const target = ready ?? current
    out(formatMatchLine({ target, running: deps.runningVersion(account), installed: target !== null, supervisor: deps.supervisorRunning() }))
    return 0
  }
  if (!deps.supervisorRunning()) { err('咕咕 server 没在运行:执行 gugu-server start'); return 3 }
  if (!parsed.now || ready !== parsed.version) {
    err(`${parsed.version} 尚未准备好或未确认重启;请等待 server 准备完成后确认现在重启。`)
    return 8
  }
  const answer = await (deps.call ?? callUpdate)(account, VERSION_RESTART_RPC, { version: ready, confirmed: true })
  const receipt = answer.result as { requested?: unknown; at?: unknown } | undefined
  if (answer.error || receipt?.requested !== true || typeof receipt.at !== 'number' || !Number.isFinite(receipt.at)) {
    err(answer.error?.message ?? 'Server did not acknowledge this restart request')
    return 6
  }
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const waitMs = deps.waitMs ?? 10 * 60_000
  const deadline = now() + waitMs
  while (now() < deadline) {
    const outcome = readUpdateRecord(deps.home)?.lastOutcome
    if (outcome?.request === receipt.at && outcome.kind !== 'waiting') {
      if (outcome.kind === 'switched' && outcome.target === ready) {
        out(formatMatchLine({ switched: ready }))
        return 0
      }
      err(outcome.kind === 'rolledBack' ? `${outcome.bad} 启动失败，已回滚到 ${outcome.back ?? 'previous version'}`
        : `换版请求 ${ready} 未完成: ${outcome.kind}`)
      return 6
    }
    await sleep(500)
  }
  err(`等了 ${Math.round(waitMs / 1000)} 秒，未收到这次安装级换版请求的结论。`)
  return 4
}
