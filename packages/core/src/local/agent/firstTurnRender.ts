import { buildAgentDeliveryEnvelope, type AgentDeliveryEnvelopeInput, type ChatEnvelopeInfo, type GuguIdentity } from './deliveryEnvelope'

/**
 * How a session's first turn is written for its agent, once the gugu message it answers has landed.
 * The landing step knows the chat; the text itself stays the pending row's own.
 */
export type FirstTurnRender =
  | Readonly<{ kind: 'plain' }>
  | Readonly<{
    kind: 'envelope'
    envelope: Omit<AgentDeliveryEnvelopeInput, 'content'>
    identities: Map<string, GuguIdentity>
    chat: ChatEnvelopeInfo
    timestamp: string
    messageContext?: string
  }>

/** Pure: the same row and context always render the same turn. */
export function renderFirstTurn(text: string, render: FirstTurnRender): { text: string; origin: 'manual' | 'communication' } {
  switch (render.kind) {
    case 'plain': return { text, origin: 'manual' }
    case 'envelope': return {
      text: buildAgentDeliveryEnvelope({ ...render.envelope, content: text }, render.identities, render.chat, render.timestamp, null, undefined,
        render.messageContext ? { messageContext: render.messageContext } : {}),
      origin: 'communication',
    }
  }
}
