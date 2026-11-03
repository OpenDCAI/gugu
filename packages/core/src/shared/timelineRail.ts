import { readDeliveryEnvelope, type DeliveryReadFacts } from '../local/agent/deliveryEnvelope'

export type TimelineRailSenderType = 'human' | 'agent'

export interface TimelineRailOptions {
  selfUserId?: string | null
  /** Historical envelopes lack from_type. Resolve their typed sender address from the identity directory. */
  resolveSenderType?: (fromId: string) => TimelineRailSenderType | null | undefined
}

export interface TimelineRailMessage {
  text: string
  /** null is a person's direct input; deliveries retain the source and sender facts. */
  sender: DeliveryReadFacts | null
}

export function isSelfSender(facts: Pick<DeliveryReadFacts, 'fromId'>, selfUserId?: string | null): boolean {
  return !!selfUserId && facts.fromId === `user:${selfUserId}`
}

/** The silence control token is never preview copy, including when adjacent to reply text. */
export function timelineRailPreviewText(text: string): string {
  return text.replaceAll('[NO_REPLY]', '').trim()
}

/**
 * Human inputs eligible for a timeline rail. Empty means no marker or preview.
 * Batches are filtered segment by segment so agent text cannot leak into a human preview.
 * Unknown historical senders wait for directory resolution instead of being assumed human.
 */
export function timelineRailMessages(text: string, options: TimelineRailOptions = {}): TimelineRailMessage[] {
  const delivery = readDeliveryEnvelope(text)
  if (!delivery) {
    const prompt = timelineRailPreviewText(text)
    return prompt ? [{ text: prompt, sender: null }] : []
  }
  return delivery.segments.flatMap(({ body, facts }) => {
    const prompt = timelineRailPreviewText(body)
    if (!prompt || !facts) return []
    if (facts.route === 'session-direct' || facts.route === 'system' || facts.route === 'scheduled') return []
    if (facts.fromType === 'agent' || /^(?:session|agent|system):/.test(facts.fromId ?? '')) return []
    const senderType = facts.fromType ?? (facts.fromId ? options.resolveSenderType?.(facts.fromId) : null)
    // App interactions are explicitly relayed on the person's behalf by this route.
    if (senderType !== 'human' && !isSelfSender(facts, options.selfUserId) && facts.route !== 'extension') return []
    if (senderType === 'agent') return []
    return [{ text: prompt, sender: facts }]
  })
}
