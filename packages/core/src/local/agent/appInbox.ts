/**
 * An App as a source of the agent inbox reader, beside chat: the cloud tells an agent something happened in an App
 * (`agent.deliver` with `source` = that App's id, no chat), and the App's own program answers what to hand over. The host
 * knows the contract and nothing of what an App keeps; one row here is one row of the reader (`AgentInboxUnreadRow.app`).
 *
 * The contract is three tools of the App's tools module, for the host only (`_meta.ui.visibility: ["app"]`):
 * `inbox_pull({ agent })` → `AppInboxRow[]`, `inbox_ack({ agent, key, seq })`, `inbox_failed({ agent, key?, command?, state, error })`.
 */
import { createHash } from 'node:crypto'
import { encodeTypedId } from '../../shared/typedId.mjs'
import { buildAppEnvelope, formatDeliveryTimestamp } from './deliveryEnvelope'
import type { AgentInboxUnreadRow } from './agentInboxReader'

/** One thing to hand this agent. `key` groups them (one acknowledgement per key, up to its highest `seq`). */
export interface AppInboxRow {
  key: string
  seq: number
  actor_user_id: string | null
  actor_name: string | null
  actor_is_agent: boolean | null
  created_at: string
  /** What the App's tools call this thing (`post:<uuid>`, say): a fact of the envelope. */
  ref: string | null
  context: string
  /** How to answer: the App's tools, named in full. */
  arrival: string
  content: string
}

export type AppInboxFailure = 'undelivered' | 'turn_failed'

/** What the host answers the reader with: only the Apps that can take a delivery here. */
export interface AppInboxPort {
  /** Why this App cannot take deliveries on this host, or null. A source asked about is remembered (the host's own). */
  refusal(source: string): Promise<string | null>
  /** Every App known as a source. One that fails is the `required` source's error, and otherwise only logged: it must not stop a chat's delivery. */
  pull(agentUserId: string, required?: string): Promise<AgentInboxUnreadRow[]>
  ack(input: { source: string; agentUserId: string; key: string; seq: number }): Promise<void>
  recordFailure(input: { source: string; agentUserId: string; key?: string; command?: Record<string, unknown>; state: AppInboxFailure; error: string }): Promise<void>
}

/** The App + its key + the sequence ⇒ the stable id of this thing (the same when delivered again), uuid-shaped. */
function appEventId(source: string, key: string, seq: number): string {
  const hex = createHash('sha256').update(`${source}:${key}:${seq}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function appInboxUnreadRow(source: string, raw: AppInboxRow): AgentInboxUnreadRow {
  const seq = Number(raw.seq)
  const id = appEventId(source, raw.key, seq)
  return {
    // Only for grouping and ordering in the reader (there is no chat): never the id of a chat, never sent as one.
    chatId: `app:${source}:${raw.key}`,
    chatKind: null,
    chatPublicId: null,
    chatName: null,
    chatCreatorUserId: null,
    listenMode: null,
    notificationLevel: null,
    lastReadSeq: 0,
    id,
    seq,
    senderUserId: raw.actor_user_id,
    senderType: raw.actor_is_agent ? 'agent' : 'human',
    senderDisplayName: raw.actor_name,
    senderGuguNumber: null,
    content: raw.content,
    contentType: 'text',
    toUserIds: null,
    isWhisper: false,
    replyToMessageId: null,
    replyToSenderUserId: null,
    replyToContent: null,
    threadRootId: null,
    isThreadRoot: false,
    createdAt: raw.created_at,
    app: {
      source,
      key: raw.key,
      seq,
      envelope: buildAppEnvelope({
        source,
        eventId: id,
        ref: raw.ref,
        from: raw.actor_name,
        fromId: raw.actor_user_id ? encodeTypedId('user', raw.actor_user_id) : null,
        at: formatDeliveryTimestamp(raw.created_at),
        context: raw.context,
        arrival: raw.arrival,
        content: raw.content,
      }),
    },
  }
}
