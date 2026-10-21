import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText, resolveGuguHome } from '@gugu/core/local/state/paths'
import type { HarnessSessionSurface } from '@gugu/session-core/agents/plugins'
import type { CapabilityLoadReport, CapabilityUnit } from './capability-bundle'

/** An agent in an IM chat: `conversationId` is the chat. */
export type CapabilityChatIdentity = {
  kind: 'acp'
  agentUserId: string
  conversationId: string
  threadRootId: string | null
}

/** A session on the session page. */
export type CapabilitySessionpageIdentity = {
  kind: 'sessionpage'
  sessionId: string
}

export type CapabilitySessionIdentity = CapabilityChatIdentity | CapabilitySessionpageIdentity

export interface PersistedCapabilityLoadReport {
  version: 2
  session: CapabilitySessionIdentity
  report: CapabilityLoadReport
  recordedAt: string
}

const SESSION_SURFACES = new Set<HarnessSessionSurface>([
  'acp',
  'tui',
  'app-server',
])
const CAPABILITY_UNITS = new Set<CapabilityUnit>([
  'mcp',
  'env',
  'model',
  'promptBlocks',
  'autonomy',
  'packages',
])

function required(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`capability report ${label} is missing`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`capability report ${label} is missing`)
  return normalized
}

function normalizeSession(input: unknown): CapabilitySessionIdentity {
  if (!input || typeof input !== 'object') {
    throw new Error('capability report session is missing')
  }
  const session = input as Record<string, unknown>
  if (session.kind === 'sessionpage') {
    return {
      kind: session.kind,
      sessionId: required(session.sessionId, 'sessionId')
    }
  }
  if (session.kind !== 'acp') {
    throw new Error(`capability report session kind is unsupported: ${String(session.kind)}`)
  }
  return {
    kind: session.kind,
    agentUserId: required(session.agentUserId, 'agentUserId'),
    conversationId: required(session.conversationId, 'conversationId'),
    threadRootId:
      session.threadRootId === null || session.threadRootId === undefined
        ? null
        : required(session.threadRootId, 'threadRootId')
  }
}

function sameSession(
  actual: CapabilitySessionIdentity,
  expected: CapabilitySessionIdentity
): boolean {
  if (actual.kind === 'sessionpage') return expected.kind === 'sessionpage' && actual.sessionId === expected.sessionId
  return (
    expected.kind === 'acp' &&
    actual.conversationId === expected.conversationId &&
    actual.agentUserId === expected.agentUserId &&
    actual.threadRootId === expected.threadRootId
  )
}

function reportFile(session: CapabilitySessionIdentity, env: NodeJS.ProcessEnv): string {
  const digest = createHash('sha256').update(JSON.stringify(session)).digest('hex')
  return join(resolveGuguHome(env), 'capability-reports', `${digest}.json`)
}

function isReport(value: unknown): value is CapabilityLoadReport {
  if (!value || typeof value !== 'object') return false
  const report = value as Partial<CapabilityLoadReport>
  return (
    typeof report.adapterId === 'string' &&
    report.adapterId.trim().length > 0 &&
    typeof report.surface === 'string' &&
    SESSION_SURFACES.has(report.surface as HarnessSessionSurface) &&
    Array.isArray(report.loaded) &&
    report.loaded.every((unit) => CAPABILITY_UNITS.has(unit)) &&
    (report.discoveredCommands === undefined || (
      Array.isArray(report.discoveredCommands) &&
      report.discoveredCommands.every((name) => typeof name === 'string')
    )) &&
    Array.isArray(report.degraded) &&
    report.degraded.every((entry) =>
      Boolean(
        entry &&
        typeof entry === 'object' &&
        CAPABILITY_UNITS.has((entry as { unit?: CapabilityUnit }).unit as CapabilityUnit) &&
        typeof (entry as { reason?: unknown }).reason === 'string'
      )
    )
  )
}

function parseRecord(text: string): PersistedCapabilityLoadReport | null {
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object') throw new Error('record is not an object')
  const envelope = parsed as Record<string, unknown>
  if (envelope.version !== 2) {
    if (
      !Number.isInteger(envelope.version) ||
      !envelope.session || typeof envelope.session !== 'object' ||
      !envelope.report || typeof envelope.report !== 'object' ||
      typeof envelope.recordedAt !== 'string' || !Number.isFinite(Date.parse(envelope.recordedAt))
    ) {
      throw new Error('record has an unsupported shape')
    }
    normalizeSession(envelope.session)
    return null
  }
  const record = parsed as Partial<PersistedCapabilityLoadReport>
  if (!record.session || !isReport(record.report)) {
    throw new Error('record has an unsupported shape')
  }
  if (typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt))) {
    throw new Error('recordedAt is invalid')
  }
  const session = normalizeSession(record.session)
  return {
    version: 2,
    session,
    report: {
      ...record.report,
      discoveredCommands: [...(record.report.discoveredCommands ?? [])]
    },
    recordedAt: record.recordedAt
  }
}

/**
 * 宿主在能力物化**之外**注入的模型 —— 按会话记下**那个决定**,供报告合并。
 *
 * ## 为什么需要它(#4689)
 *
 * `capability-bundle` 的 spec 开篇写着这份报告是「gugu 给每个 agent session 的**全部** harness
 * 配置收敛为**一份声明**」,env 与模型配置都在其中。而平台模型对 copilot/qwen/kimi 这一族走的是
 * 第三支信封 `adapter-env`:整份是环境变量,由**宿主**在能力物化之外注入(`platformEnvelopeKind`)。
 * 报告只看得见 bundle 那条输入 ⇒ 它对这一族**结构性地报 degraded**,与模型到没到无关。
 *
 * 实测(#4689):`COPILOT_PROVIDER_MODEL_ID` 等三个变量名在 provider 进程 env 里全在,
 * 而同一条会话的报告记 degraded。⇒ 那不是「窄但诚实」,是这份**统一声明漏报了它本该统一的一半**。
 * 后果不是纸面的:#4667 的读数器据这一格把 12 轮阳控判成 RIG-FAIL 全部作废,数据已丢。
 *
 * ## ⚠️ 数据源是**决定**,不是活进程
 *
 * ❌ 报告不去 `ps eww` 读进程环境 —— 那会让报告依赖进程存活(进程没了就读不到),
 * 那是把报告绑到活进程上的**新**缺陷。这里记的是宿主**决定注入的那一刻**的事实。
 * 进程 env 里的变量名是**判据的仪器**,不是报告的数据源;两者独立,才能互相判假。
 *
 * ## 顺序无关
 *
 * 注入器与写报告是两个 hook,谁先跑不保证。所以两边都接:先注入就等写报告时合并,
 * 先写报告就当场补写。❌ 不做「找不到报告就静默跳过」——那正是本票要修的那类沉默。
 */
const hostInjectedModel = new Map<string, string>()

/** 宿主决定为这条会话注入平台模型时调用。幂等。 */
export async function noteHostInjectedModel(
  sessionId: string,
  modelId: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const id = sessionId.trim()
  const model = modelId.trim()
  if (!id || !model) throw new Error('noteHostInjectedModel requires a session id and a model id')
  hostInjectedModel.set(id, model)
  // 报告可能已经写过了(两个 hook 的顺序不保证)⇒ 当场补写,而不是等下一次。
  const session: CapabilitySessionIdentity = { kind: 'sessionpage', sessionId: id }
  const existing = await readCapabilityLoadReport(session, env)
  if (existing) await writeCapabilityLoadReport(session, existing.report, env)
}

/**
 * 把宿主那条注入并进报告的 `model` 单元。
 *
 * 合并只朝一个方向:宿主注入过 ⇒ `model` 记 loaded,并从 degraded 里摘掉那一条。
 * ❌ 反向不成立(报告说 loaded 而宿主没注入时不改它)—— 那是 bundle 自己交付的模型,同样为真。
 */
function mergeHostInjectedModel(
  session: CapabilitySessionIdentity,
  report: CapabilityLoadReport,
): CapabilityLoadReport {
  if (session.kind !== 'sessionpage') return report
  if (!hostInjectedModel.has(session.sessionId)) return report
  if (report.loaded.includes('model')) return report
  return {
    ...report,
    loaded: [...report.loaded, 'model'],
    degraded: report.degraded.filter((entry) => entry.unit !== 'model'),
  }
}

export async function writeCapabilityLoadReport(
  sessionInput: CapabilitySessionIdentity,
  report: CapabilityLoadReport,
  env: NodeJS.ProcessEnv,
  now = new Date()
): Promise<PersistedCapabilityLoadReport> {
  const session = normalizeSession(sessionInput)
  if (!isReport(report)) throw new Error('capability report has an unsupported shape')
  const merged = mergeHostInjectedModel(session, report)
  const record: PersistedCapabilityLoadReport = {
    version: 2,
    session,
    report: {
      adapterId: merged.adapterId,
      surface: merged.surface,
      // ⚠️ 这四格必须一起读 `merged` —— 只把 adapterId 换成 merged 而其余仍读 report,
      //    合并就一个字节都不生效,而改动看起来是"已应用"的。(写这段时我自己先犯了一次。)
      loaded: [...merged.loaded],
      degraded: merged.degraded.map((entry) => ({ ...entry })),
      discoveredCommands: [...merged.discoveredCommands]
    },
    recordedAt: now.toISOString()
  }
  await atomicWriteText(reportFile(session, env), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

export async function readCapabilityLoadReport(
  sessionInput: CapabilitySessionIdentity,
  env: NodeJS.ProcessEnv
): Promise<PersistedCapabilityLoadReport | null> {
  const session = normalizeSession(sessionInput)
  try {
    const record = parseRecord(await readFile(reportFile(session, env), 'utf8'))
    if (!record) return null
    if (!sameSession(record.session, session)) {
      throw new Error('persisted session identity does not match the query')
    }
    return record
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`capability report is unreadable: ${(error as Error).message}`)
  }
}
