export type ProviderReviewGate = 'mcp'
export type ProviderBlocker = {
  kind: 'provider'
  reason: 'workspace-trust' | 'hook-trust' | 'auth' | 'account' | 'config'
  message: string
}
const PROVIDER_BLOCKER_REASONS = new Set<ProviderBlocker['reason']>(['workspace-trust', 'hook-trust', 'auth', 'account', 'config'])
export type PlatformRecovery = {
  status: 'live' | 'expired' | 'reopening' | 'failed'
  error?: string
}

export interface SessionpageOpenTarget {
  projectId: string
  sessionId: string
}

/**
 * 这个 agent 映射到会话页的哪条会话,以及只在会话面上显形的平台恢复。它的状态、审阅门与 provider 阻塞
 * ❌ 在这里:那些是宿主按 agent 的流里的读数(agentPresenceStore 的 `local`),同一件事只走一条通道。
 */
export interface SessionpageAgentContext extends SessionpageOpenTarget {
  /** 这条会话现在以哪种展示开(编程 / 通用);null = 读不到(会话已不在)。私聊头部模式按钮用(#7167)。 */
  view: SessionpageSessionView | null
  platformRecovery: PlatformRecovery | null
  projectionError: string | null
}

export type SessionpageSessionView = 'code' | 'general'

export function parseSessionpageSessionView(value: unknown): SessionpageSessionView | null {
  if (value == null) return null
  if (value === 'code' || value === 'general') return value
  throw new Error('session-page agent context has an invalid view')
}

export function parseProviderReviewGate(value: unknown): ProviderReviewGate | null {
  if (value === null) return null
  if (value === 'mcp') return value
  throw new Error('session-page agent status has an invalid review gate')
}

export function parseProviderBlocker(value: unknown): ProviderBlocker | null {
  if (value == null) return null
  if (!value || typeof value !== 'object') throw new Error('session-page agent status has an invalid provider blocker')
  const row = value as Record<string, unknown>
  if (
    row.kind !== 'provider'
    || !PROVIDER_BLOCKER_REASONS.has(row.reason as ProviderBlocker['reason'])
    || typeof row.message !== 'string'
    || !row.message.trim()
  ) {
    throw new Error('session-page agent status has an invalid provider blocker')
  }
  return {
    kind: 'provider',
    reason: row.reason as ProviderBlocker['reason'],
    message: row.message,
  }
}

export function parsePlatformRecovery(value: unknown): PlatformRecovery | null {
  if (value == null) return null
  if (!value || typeof value !== 'object') throw new Error('session-page agent context has an invalid platform recovery state')
  const row = value as Record<string, unknown>
  if (!['live', 'expired', 'reopening', 'failed'].includes(String(row.status))) {
    throw new Error('session-page agent context has an invalid platform recovery status')
  }
  if (row.error !== undefined && typeof row.error !== 'string') {
    throw new Error('session-page agent context has an invalid platform recovery error')
  }
  if (
    (row.status === 'failed' && typeof row.error !== 'string')
    || (row.status !== 'failed' && row.error !== undefined)
  ) {
    throw new Error('session-page agent context has an invalid platform recovery error state')
  }
  return {
    status: row.status as PlatformRecovery['status'],
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
  }
}

function requiredId(value: unknown, field: keyof SessionpageOpenTarget): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`session-page agent context has no ${field}`)
  }
  return value
}

export function parseSessionpageAgentContext(value: unknown): SessionpageAgentContext | null {
  if (value === null) return null
  if (!value || typeof value !== 'object') throw new Error('session-page agent context is malformed')
  const row = value as Record<string, unknown>
  if (row.projectionError !== null && typeof row.projectionError !== 'string') {
    throw new Error('session-page agent context has an invalid projection error')
  }
  return {
    projectId: requiredId(row.projectId, 'projectId'),
    sessionId: requiredId(row.sessionId, 'sessionId'),
    view: parseSessionpageSessionView(row.view),
    platformRecovery: parsePlatformRecovery(row.platformRecovery),
    projectionError: row.projectionError as string | null,
  }
}
