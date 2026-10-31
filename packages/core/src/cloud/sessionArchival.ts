import { getSupabaseAnonKey, getSupabaseUrl } from './config'
import type { SessionArchiveInterval } from '../shared/sessionArchival'

export interface AgentSessionArchivalOperation {
  operationId: string
  revision: number
  archivedAt: string | null
  intervals: SessionArchiveInterval[]
}

async function request(path: string, token: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${getSupabaseUrl()}/rest/v1/${path}`, {
    ...init, signal: AbortSignal.timeout(12_000),
    headers: { apikey: getSupabaseAnonKey(), Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json', 'Content-Profile': 'identity', 'Accept-Profile': 'identity' },
  })
  const body = await response.json() as { code?: string; message?: string }
  if (!response.ok) throw Object.assign(new Error(body.message || `Session archival request failed (${response.status})`), { code: body.code })
  return body
}

export async function agentSessionArchivalRevision(agentUserId: string, token: string): Promise<number> {
  const rows = await request(`users?id=eq.${encodeURIComponent(agentUserId)}&select=session_lifecycle_revision`, token) as Array<{ session_lifecycle_revision: number }>
  const revision = rows[0]?.session_lifecycle_revision
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Agent session archival revision is unavailable')
  return revision
}

export function agentSessionArchivalRpcArgs(agentUserId: string, deviceId: string, operation: AgentSessionArchivalOperation) {
  return {
    p_agent_user_id: agentUserId, p_device_id: deviceId, p_operation_id: operation.operationId,
    p_revision: operation.revision, p_archived_at: operation.archivedAt,
    p_intervals: operation.intervals.map((interval) => ({ id: interval.id, archived_at: interval.archivedAt, restored_at: interval.restoredAt })),
  }
}

export async function syncAgentSessionArchival(agentUserId: string, deviceId: string, token: string, operation: AgentSessionArchivalOperation): Promise<void> {
  const receipt = await request('rpc/set_agent_session_archival', token, { method: 'POST', body: JSON.stringify(agentSessionArchivalRpcArgs(agentUserId, deviceId, operation)) }) as { agent_user_id?: string; operation_id?: string; revision?: number }
  if (receipt.agent_user_id !== agentUserId || receipt.operation_id !== operation.operationId || receipt.revision !== operation.revision) {
    throw new Error('Agent session archival receipt does not match the persisted operation')
  }
}
