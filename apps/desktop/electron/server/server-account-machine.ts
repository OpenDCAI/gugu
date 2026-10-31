/**
 * #6264 一个账号跑哪一版:守护进程为每个账号持有一台状态机,`step(state, event) → { state, effects }` 是纯函数。
 *
 * 状态只有一份,存在账号目录的 server-update.json(原子写)。CLI(match-version)、设备行(心跳读它)、status
 * 都只读这一份;❌ 再从 pin / 换版请求 / 进程表里倒推结果。
 *
 *   running      在跑 version(null = 守护进程自己那一版),没有要做的
 *   staging      目标没装好:下载 / 校验 / 试跑一个账号(scratch boot)
 *   failed       目标在冷却中:failures[target] 记着原因与到期时刻
 *   waiting      装好了,等人确认现在重启(「现在重启更新」/ --now):换版要结束账号进程,❌ 自己打断在跑的任务
 *   booting      已切到新版本,等新进程第一次报出自己的心跳;秒退三次或超时 ⇒ 退回 previous
 *
 * 自动换版只在冷启动(这次守护进程还没起过这个账号)时发生;空闲时自动换等 session-life 的 versionHandoff
 * (非破坏性探测 + 跨进程租约)接上再加回来。
 *
 * 冷却:install / unreachable 由比失败更晚的任何请求解除;boot 只认比失败更晚、目标正是这一版的确认重启。
 */
import fs from 'node:fs'
import path from 'node:path'
import { isServerVersion } from '@gugu/core/cloud/serverDesktopVersions'
import { SERVER_UPDATE_STATE_FILE } from '@gugu/core/cloud/deviceHostInfo'

export const ACCOUNT_STATE_FILE = SERVER_UPDATE_STATE_FILE
/** 一版失败之后多久不再自己试。 */
export const VERSION_FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000
/** 下载站上还没有这一版:第 n 次 404 之后隔多久再取(5 分钟起,翻倍,最多 6 小时)。 */
export const VERSION_NOT_PUBLISHED_RETRY_MS = 5 * 60 * 1000
export const notPublishedRetryMs = (attempts: number): number =>
  Math.min(VERSION_NOT_PUBLISHED_RETRY_MS * 2 ** Math.max(0, attempts - 1), VERSION_FAILURE_COOLDOWN_MS)
export const QUICK_EXITS_TO_ROLL_BACK = 3
export const BOOT_READY_TIMEOUT_MS = 120_000

export type FailureCause = 'install' | 'unreachable' | 'boot'
export type Failure = { cause: FailureCause; at: number; until: number; attempts: number }
export type SwitchRequest = { at: number; confirmed: boolean; target?: string }
/** 守护进程对一次换版请求(或一次自动换版)的结论;request = 那次请求的 at。 */
export type Outcome =
  | { kind: 'switched'; target: string; at: number; request?: number }
  | { kind: 'rolledBack'; bad: string; back: string | null; at: number; request?: number }
  | { kind: 'failed'; target: string; cause: FailureCause; at: number; request?: number }
  | { kind: 'refused'; target: string; cause: FailureCause; at: number; request: number }
  | { kind: 'waiting'; target: string; at: number; request: number }
export type Phase =
  | { kind: 'running' }
  | { kind: 'staging'; target: string; request?: number }
  | { kind: 'failed'; target: string }
  | { kind: 'waiting'; target: string }
  | { kind: 'booting'; since: number; quickExits: number; request?: number }
export type ChildState = 'running' | 'restarting' | 'none'
export type AccountState = {
  /** 账号进程跑哪一版;null = 守护进程自己那一版。 */
  version: string | null
  /** 守护进程自己那一版(version 为 null 时账号跑的就是它)。 */
  supervisor: string | null
  /** 退回用的上一版(只在 booting 期间有意义)。 */
  previous: string | null
  phase: Phase
  failures: Record<string, Failure>
  child: ChildState
  lastOutcome: Outcome | null
}
export const INITIAL_ACCOUNT_STATE: AccountState = { version: null, supervisor: null, previous: null, phase: { kind: 'running' }, failures: {}, child: 'none', lastOutcome: null }

/**
 * 账号的进程此刻的样子:idle / busy = 它自己(pid 对得上)的新鲜心跳;unverified = 没有这样的心跳(退避重启、过期);
 * cold = 这次守护进程启动后还没起过它(切 pin 不打断任何东西)。
 */
export type ActivityProof = 'idle' | 'busy' | 'unverified' | 'cold'

export type AccountEvent =
  | {
    type: 'tick'
    now: number
    /** 守护进程自己那一版。 */
    supervisor: string
    /** 受控云电脑:账号只跟随守护进程的包,而且那个包也得先通过账号试跑(version 为 null 不等于已经在跑它)。 */
    managed: boolean
    /** 这个账号此刻该跑的那一版(桌面报告里最新的、确认请求指定的,或受控云电脑上守护进程的包)。 */
    target: string
    /** target 装好且通过了账号试跑。 */
    ready: boolean
    request: SwitchRequest | null
    proof: ActivityProof
    child: ChildState
  }
  | { type: 'staged'; now: number; version: string }
  | { type: 'stageFailed'; now: number; version: string; cause: FailureCause; notPublished?: boolean }
  | { type: 'childExited'; now: number; quick: boolean }

export type AccountEffect =
  | { type: 'stage'; version: string }
  /** 结束账号进程;守护进程按新的 version 重新拉起。 */
  | { type: 'restart' }
  | { type: 'consumeRequest' }
  | { type: 'log'; level: 'info' | 'warn'; message: string; fields: Record<string, unknown> }

type Step = { state: AccountState; effects: AccountEffect[] }

export function step(state: AccountState, event: AccountEvent): Step {
  switch (event.type) {
    case 'tick': return tick(state, event)
    case 'staged': return { state, effects: [{ type: 'log', level: 'info', message: '那一版装好了', fields: { version: event.version } }] }
    case 'stageFailed': {
      const previous = state.failures[event.version]
      const attempts = (previous?.attempts ?? 0) + 1
      const until = event.now + (event.notPublished ? notPublishedRetryMs(attempts) : VERSION_FAILURE_COOLDOWN_MS)
      const failures = { ...state.failures, [event.version]: { cause: event.cause, at: event.now, until, attempts } }
      const request = state.phase.kind === 'staging' && state.phase.target === event.version ? state.phase.request : undefined
      return {
        state: { ...state, failures, phase: { kind: 'failed', target: event.version },
          lastOutcome: { kind: 'failed', target: event.version, cause: event.cause, at: event.now, ...(request !== undefined ? { request } : {}) } },
        effects: [
          ...(request !== undefined ? [{ type: 'consumeRequest' } as const] : []),
          { type: 'log', level: 'warn', message: '装那一版失败,冷却后再试', fields: { version: event.version, cause: event.cause, until } },
        ],
      }
    }
    case 'childExited': {
      const child: ChildState = 'restarting'
      if (state.phase.kind !== 'booting' || !event.quick) return { state: { ...state, child }, effects: [] }
      const quickExits = state.phase.quickExits + 1
      if (quickExits < QUICK_EXITS_TO_ROLL_BACK) return { state: { ...state, child, phase: { ...state.phase, quickExits } }, effects: [] }
      return rollBack({ ...state, child }, event.now, false)
    }
  }
}

function tick(state: AccountState, event: Extract<AccountEvent, { type: 'tick' }>): Step {
  const { now, target, request, proof } = event
  const failures = Object.fromEntries(Object.entries(state.failures).filter(([, failure]) => failure.until > now))
  const s: AccountState = { ...state, failures, child: event.child, supervisor: event.supervisor }
  const current = s.version ?? (event.managed ? null : event.supervisor)

  if (s.phase.kind === 'booting') {
    // 新进程第一次报出自己的心跳(idle 或 busy)= 起来了。
    if (event.child === 'running' && (proof === 'idle' || proof === 'busy')) {
      const request = s.phase.request
      return {
        state: { ...s, previous: null, phase: { kind: 'running' },
          lastOutcome: { kind: 'switched', target: s.version ?? event.supervisor, at: now, ...(request !== undefined ? { request } : {}) } },
        effects: [],
      }
    }
    if (now - s.phase.since >= BOOT_READY_TIMEOUT_MS) return rollBack(s, now, true)
    return { state: s, effects: [] }
  }

  // 已经是目标:请求就此作答(换过去了)。受控云电脑上守护进程的包也得先通过账号试跑才算。
  if (target === current && (event.ready || !event.managed)) {
    return {
      state: { ...s, phase: { kind: 'running' }, ...(request ? { lastOutcome: { kind: 'switched', target, at: now, request: request.at } } : {}) },
      effects: request ? [{ type: 'consumeRequest' }] : [],
    }
  }
  const failure = failures[target]
  if (failure) {
    const lifted = request !== null && request.at > failure.at
      && (failure.cause !== 'boot' || (request.confirmed && (request.target ?? target) === target))
    if (!lifted) {
      const refused = request !== null && request.at > failure.at
      return {
        state: { ...s, phase: { kind: 'failed', target },
          ...(refused ? { lastOutcome: { kind: 'refused', target, cause: failure.cause, at: now, request: request.at } } : {}) },
        effects: refused ? [{ type: 'consumeRequest' }] : [],
      }
    }
    delete failures[target]
  }
  const confirmed = request?.confirmed === true && (request.target ?? target) === target
  if (!event.ready) {
    const staging = s.phase.kind === 'staging' && s.phase.target === target
    return {
      state: { ...s, phase: { kind: 'staging', target, ...(confirmed ? { request: request.at } : {}) } },
      effects: staging ? [] : [{ type: 'stage', version: target }, { type: 'log', level: 'info', message: '目标包尚未装好,后台准备那一版', fields: { version: target } }],
    }
  }
  if (confirmed) return switchTo(s, target, now, true, request.at)
  if (proof === 'cold') return switchTo(s, target, now, false, undefined)
  const answered = s.lastOutcome?.kind === 'waiting' && s.lastOutcome.request === request?.at
  return {
    state: { ...s, phase: { kind: 'waiting', target },
      ...(request && !answered ? { lastOutcome: { kind: 'waiting', target, at: now, request: request.at } } : {}) },
    effects: [],
  }
}

function switchTo(s: AccountState, target: string, now: number, urgent: boolean, request: number | undefined): Step {
  const running = s.child === 'running'
  return {
    state: { ...s, version: target, previous: s.version, phase: { kind: 'booting', since: now, quickExits: 0, ...(request !== undefined ? { request } : {}) } },
    effects: [
      ...(request !== undefined ? [{ type: 'consumeRequest' } as const] : []),
      ...(running ? [{ type: 'restart' } as const] : []),
      { type: 'log', level: 'info', message: '这个账号换到目标版本', fields: { from: s.version, to: target, urgent } },
    ],
  }
}

/** 新版本起不来:记下 boot 失败,退回 previous;它还活着(超时没报心跳)就结束它。 */
function rollBack(s: AccountState, now: number, alive: boolean): Step {
  const bad = s.version as string
  const request = s.phase.kind === 'booting' ? s.phase.request : undefined
  return {
    state: {
      ...s,
      version: s.previous,
      previous: null,
      phase: { kind: 'running' },
      failures: { ...s.failures, [bad]: { cause: 'boot', at: now, until: now + VERSION_FAILURE_COOLDOWN_MS, attempts: (s.failures[bad]?.attempts ?? 0) + 1 } },
      lastOutcome: { kind: 'rolledBack', bad, back: s.previous, at: now, ...(request !== undefined ? { request } : {}) },
    },
    effects: [
      ...(alive ? [{ type: 'restart' } as const] : []),
      { type: 'log', level: 'warn', message: '换过去的那一版在这台机器上起不来,退回原来那一版', fields: { version: bad, back: s.previous } },
    ],
  }
}

/**
 * 写盘的样子:完整状态 + 老读者(旧版本账号进程的设备行心跳、旧 CLI)认得的四个字段 state / version / at / reason。
 * 超集契约:老读者只看这四个字段,新字段对它们透明。
 */
export function serializeAccountState(s: AccountState, now: number): string {
  const legacy: { state?: 'downloading' | 'ready' | 'failed'; version?: string; reason?: string } =
    s.phase.kind === 'staging' ? { state: 'downloading', version: s.phase.target }
      : s.phase.kind === 'waiting' ? { state: 'ready', version: s.phase.target }
          : s.phase.kind === 'failed' ? (() => {
            const cause = s.failures[s.phase.target]?.cause
            return { state: 'failed' as const, version: s.phase.target, ...(cause === 'boot' ? { reason: 'boot-failed' } : cause === 'unreachable' ? { reason: 'unreachable' } : {}) }
          })()
            : {}
  return JSON.stringify({ ...legacy, at: now, account: s })
}

export function parseAccountState(text: string | null): AccountState | null {
  if (!text) return null
  try {
    const value = (JSON.parse(text) as { account?: Partial<AccountState> }).account
    if (!value || typeof value !== 'object' || !value.phase || typeof value.phase.kind !== 'string') return null
    return {
      version: isServerVersion(value.version) ? value.version : null,
      supervisor: isServerVersion(value.supervisor) ? value.supervisor : null,
      previous: isServerVersion(value.previous) ? value.previous : null,
      phase: value.phase,
      failures: value.failures && typeof value.failures === 'object' ? value.failures : {},
      child: value.child === 'running' || value.child === 'restarting' ? value.child : 'none',
      lastOutcome: value.lastOutcome ?? null,
    }
  } catch {
    return null
  }
}

export function readAccountState(dataDir: string): AccountState | null {
  try {
    return parseAccountState(fs.readFileSync(path.join(dataDir, ACCOUNT_STATE_FILE), 'utf8'))
  } catch {
    return null
  }
}

export function writeAccountState(dataDir: string, s: AccountState, now: number): void {
  const file = path.join(dataDir, ACCOUNT_STATE_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(tmp, serializeAccountState(s, now), { mode: 0o600 })
  fs.renameSync(tmp, file)
}
