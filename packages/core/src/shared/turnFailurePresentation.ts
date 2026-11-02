import { agentFailureNeedsModelChoice, type AgentFailureReason } from './agentQuotaReason'

/** Cards, previews and notifications all say a failure from the reason the host recorded, in the same localized words. */
export function turnFailurePresentation(reason: AgentFailureReason) {
  const modelChoice = agentFailureNeedsModelChoice(reason)
  const title = modelChoice || reason === 'notAdmitted' || reason === 'undelivered' ? null : reason
  return {
    tone: reason === 'authentication' || modelChoice ? 'danger' as const : 'warn' as const,
    titleKey: title ? `agent.turnFailure.card.${title}` as const : `agent.turnFailure.${reason}` as const,
    bodyKey: `agent.turnFailure.${reason}` as const,
    nextMessageKey: 'agent.turnFailure.card.nextMessage' as const,
    recoveredKey: 'agent.turnFailure.card.recovered' as const,
    // undelivered: no running instance holds the agent, so resending lands on the same nobody; only opening it helps.
    actions: modelChoice ? ['model', 'retry'] as const : reason === 'authentication' ? ['settings', 'retry'] as const
      : reason === 'undelivered' ? [] as const : ['retry'] as const,
  }
}
