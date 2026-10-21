import type { SessionpageTimelineClient } from '@/mobile/agent-watch/use-timeline-session'
import * as remote from '@/mobile/agent-watch/sessionpage-rpc'
import { rpcOn, events } from '@/session/renderer/lib/ipc'
import { sessionpageSessionTimelineChannel } from '@/session/shared/core/session-timeline/sessionTimelineEvents'

async function value<T>(result: Promise<{ ok: true; value: T } | { ok: false; error: { code: string; message: string } }>): Promise<T> {
  const next = await result
  if (!next.ok) throw Object.assign(new Error(next.error.message), { code: next.error.code })
  return next.value
}

// Reuse the existing timeline consumer, including cursor recovery and unsubscribe ownership.
const local: SessionpageTimelineClient = {
  fetchSnapshot: (_, sessionId, limit) => value(rpcOn(null).sessionTimeline.sessionSnapshot({ conversationId: sessionId, limit: limit ?? 30, trim: true })),
  fetchAfter: (_, sessionId, cursor) => value(rpcOn(null).sessionTimeline.sessionAfter({ conversationId: sessionId, cursor, trim: true })),
  fetchOlder: (_, sessionId, beforeTurnId, limit) => value(rpcOn(null).sessionTimeline.sessionOlder({ conversationId: sessionId, beforeTurnId, limit, trim: true })),
  fetchToolImage: (_, sessionId, itemId, index) => value(rpcOn(null).sessionTimeline.sessionToolImage({ conversationId: sessionId, itemId, index })),
  subscribeSession: (_, sessionId, subscriptionId, cursor) => value(rpcOn(null).sessionTimeline.sessionSubscribe({ conversationId: sessionId, subscriptionId, cursor, trim: true })),
  unsubscribeSession: (_, subscriptionId) => rpcOn(null).sessionTimeline.sessionUnsubscribe({ subscriptionId }),
  subscribeSessionEvents: (_, id, receive) => events.on(sessionpageSessionTimelineChannel, (event) => receive(event.result), id),
  onLinkChange: () => () => undefined,
  sendSessionText: (_, sessionId, text) => value(rpcOn(null).sessionTimeline.sessionSend({ conversationId: sessionId, text })),
  cancelSessionTurn: (_, sessionId) => value(rpcOn(null).sessionTimeline.sessionCancel({ conversationId: sessionId })),
  respondToSettlement: (_, input) => value(rpcOn(null).sessionTimeline.sessionRespond(input)),
}

const remoteClient: SessionpageTimelineClient = { ...remote, fetchSnapshot: (device, session, limit) => remote.fetchSnapshot(device, session, limit ?? 30) }

export function assistantTimelineClient(isLocal: boolean): SessionpageTimelineClient {
  return isLocal ? local : remoteClient
}
