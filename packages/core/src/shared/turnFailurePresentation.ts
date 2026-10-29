import { agentFailureNeedsModelChoice, agentFailureReason, type AgentFailureReason } from './agentQuotaReason'

/** Presentation only: the host's persisted failure reasons and delivery protocol stay unchanged. */
export type TurnFailureReason = AgentFailureReason | 'offline'

export function turnFailureReasonFromError(raw: string | null | undefined): TurnFailureReason {
  const reason = agentFailureReason(raw)
  if (reason) return reason
  const text = (raw ?? '').trim()
  if (!text) return 'timeout'
  return /offline|离线|not connected|disconnected/i.test(text) ? 'offline' : 'generic'
}

/** Both cards, previews and notifications use the same reason and localized cause. */
export function turnFailurePresentation(reason: TurnFailureReason) {
  const modelChoice = reason !== 'offline' && agentFailureNeedsModelChoice(reason)
  const title = modelChoice || reason === 'notAdmitted' || reason === 'undelivered' ? null : reason
  return {
    tone: reason === 'authentication' || modelChoice ? 'danger' as const : 'warn' as const,
    titleKey: title ? `agent.turnFailure.card.${title}` as const : `agent.turnFailure.${reason}` as const,
    bodyKey: `agent.turnFailure.${reason}` as const,
    nextMessageKey: 'agent.turnFailure.card.nextMessage' as const,
    recoveredKey: 'agent.turnFailure.card.recovered' as const,
    actions: modelChoice ? ['model', 'retry'] as const : reason === 'authentication' ? ['settings', 'retry'] as const : ['retry'] as const,
  }
}
