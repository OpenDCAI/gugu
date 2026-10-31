// 额度/模型类只决定行内状态，不再保存通知去重状态。
import { agentModelUnavailable, agentQuotaReason } from '@gugu/core/shared/agentQuotaReason'

export type AgentTurnFailureMuteKind = 'weekly' | 'monthly' | 'exhausted' | 'model-unavailable'

export function agentTurnFailureMuteKind(raw: string | null | undefined): AgentTurnFailureMuteKind | null {
  const reason = agentQuotaReason(raw)
  if (reason && reason !== 'rate-limited') return reason
  return agentModelUnavailable(raw) ? 'model-unavailable' : null
}
