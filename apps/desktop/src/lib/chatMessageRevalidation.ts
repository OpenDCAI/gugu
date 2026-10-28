import { messageItemFromRow, MESSAGES_VIEW_SELECT, type RawMessageRow } from '@gugu/core/cloud/messageItem'
import { agentReaderUserId } from '@gugu/core/shared/ui/messageState'
import type {
  MessageContentType,
  MessageDeliveryStatus,
  MessageItem,
  ReactionGroup,
} from '@gugu/core/shared/types/chat'
import { chatDb } from './supabase'

export interface MessageOverlay {
  reactions: ReactionGroup[]
  delivered: boolean
  delivery_status: MessageDeliveryStatus | null
  // @@@per-message-read (#598) - recipient user_ids with a 'read' delivery row for this message (any agent,
  // not just the viewer's own) — RLS already exposes co-members' rows. Powers watermark-independent receipts.
  readers: string[]
  delivery_blocks: NonNullable<MessageItem['delivery_blocks']>
}

// @@@msg-cache (#621/P2/#947) - the mutable BODY fields of an already-cached message that can change after
// it was fetched and have no realtime: an edit rewrites content/content_type, a retract stamps
// retracted_at. A delete (global or delete-for-me) removes the id from the view entirely — that case
// is reported via `presentIds` below, not here.
export interface MessageMutationPatch {
  content: string | null
  content_type: MessageContentType
  retracted_at: string | null
}

// @@@msg-cache (#621/P2/#947) - bounded reopen revalidation result over the cached window's ids. Carries
// the reaction/delivery overlays AND the edit/retract body patches AND the set of ids that still exist for
// this user (re-queried with the SAME deleted filters as getMessages). The caller patches surviving rows in
// place and drops ids missing from `presentIds` — NO body refetch of new messages. This is the second
// staleness vector the persistent L2 cache introduces: edit/retract/delete-while-closed (no realtime).
export interface WindowRevalidation {
  overlays: Map<string, MessageOverlay>
  mutations: Map<string, MessageMutationPatch>
  presentIds: Set<string>
}

export function applyMessageWindowRevalidation(
  list: MessageItem[],
  queriedIds: ReadonlySet<string>,
  result: WindowRevalidation,
): MessageItem[] {
  const next: MessageItem[] = []
  for (const message of list) {
    // A revalidation response only has authority over the exact id snapshot it queried. A persisted
    // message can arrive while that request is in flight; absence from an older result says nothing
    // about the new row and must not erase it from the transcript.
    if (message.seq < 0 || !queriedIds.has(message.id)) {
      next.push(message)
      continue
    }
    if (!result.presentIds.has(message.id)) continue
    const overlay = result.overlays.get(message.id)
    const mutation = result.mutations.get(message.id)
    next.push(overlay || mutation ? { ...message, ...(overlay ?? {}), ...(mutation ?? {}) } : message)
  }
  return next
}

// @@@overlay-in-chunked — see git history for full context.
const OVERLAY_IN_CHUNK = 64

async function fetchOverlayRows<T>(
  table: 'message_reactions' | 'message_deliveries' | 'message_agent_wakes' | 'message_agent_delivery_blocks',
  columns: string,
  messageIds: string[]
): Promise<T[]> {
  const rows: T[] = []
  for (let i = 0; i < messageIds.length; i += OVERLAY_IN_CHUNK) {
    const chunk = messageIds.slice(i, i + OVERLAY_IN_CHUNK)
    const { data, error } = await chatDb.from(table).select(columns).in('message_id', chunk)
    if (error) {
      if (table === 'message_agent_delivery_blocks') throw new Error(`Message refusal status is unavailable: ${error.message}`)
      console.warn(
        `[chat] ${table} overlay fetch failed (offset ${i}/${messageIds.length}): ${error.message}`
      )
      continue
    }
    if (data) rows.push(...(data as T[]))
  }
  return rows
}

/** The agents each message wakes (chat.message_agent_wakes: decided once, when it was written). Unreadable = none known. */
export async function loadMessageAgentWakes(messageIds: string[]): Promise<Map<string, Set<string>>> {
  const wakes = new Map<string, Set<string>>()
  const [rows, blocks] = await Promise.all([
    fetchOverlayRows<{ message_id: string; agent_user_id: string }>('message_agent_wakes', 'message_id, agent_user_id', messageIds),
    fetchOverlayRows<{ message_id: string; agent_user_id: string }>('message_agent_delivery_blocks', 'message_id, agent_user_id', messageIds),
  ])
  const refused = new Set(blocks.map((row) => `${row.message_id}/${row.agent_user_id}`))
  for (const row of rows) if (!refused.has(`${row.message_id}/${row.agent_user_id}`)) wakes.set(row.message_id, (wakes.get(row.message_id) ?? new Set()).add(row.agent_user_id))
  return wakes
}

export async function loadMessageOverlays(
  messageIds: string[],
  userId: string
): Promise<Map<string, MessageOverlay>> {
  const out = new Map<string, MessageOverlay>()
  if (messageIds.length === 0) return out
  const [reactions, deliveries, blocks] = await Promise.all([
    fetchOverlayRows<{ message_id: string; user_id: string; emoji: string }>(
      'message_reactions', 'message_id, user_id, emoji', messageIds,
    ),
    fetchOverlayRows<{ message_id: string; status: MessageDeliveryStatus; device_id: string }>(
      'message_deliveries', 'message_id, status, device_id', messageIds,
    ),
    fetchOverlayRows<{ message_id: string; agent_user_id: string; reason: 'agent_archived' }>(
      'message_agent_delivery_blocks', 'message_id, agent_user_id, reason', messageIds,
    ),
  ])

  const reactionsMap = new Map<string, ReactionGroup[]>()
  for (const r of reactions) {
    const groups = reactionsMap.get(r.message_id) ?? []
    const existing = groups.find((g) => g.emoji === r.emoji)
    if (existing) {
      existing.count++
      if (r.user_id === userId) existing.my_reaction = true
    } else {
      groups.push({ emoji: r.emoji, count: 1, my_reaction: r.user_id === userId })
    }
    reactionsMap.set(r.message_id, groups)
  }
  const deliveredMessageIds = new Set<string>()
  const ownDeliveryStatusMap = new Map<string, MessageDeliveryStatus>()
  // @@@per-message-read (#598) - per-message set of recipient agents that have READ it (any agent, not just
  // the viewer's own). Decoupled from the watermark so directed receipts flip even when last_read_seq is stuck.
  const readersMap = new Map<string, Set<string>>()
  for (const d of deliveries) {
    deliveredMessageIds.add(d.message_id)
    if (d.status === 'read') {
      const reader = agentReaderUserId(d.device_id)
      if (reader) {
        const set = readersMap.get(d.message_id) ?? new Set<string>()
        set.add(reader)
        readersMap.set(d.message_id, set)
      }
    }
    if (d.device_id !== `gugu-agent:${userId}`) continue
    const current = ownDeliveryStatusMap.get(d.message_id)
    if (d.status === 'read' || !current) ownDeliveryStatusMap.set(d.message_id, d.status)
  }
  for (const id of messageIds) {
    out.set(id, {
      reactions: reactionsMap.get(id) ?? [],
      delivered: deliveredMessageIds.has(id),
      delivery_status: ownDeliveryStatusMap.get(id) ?? null,
      readers: [...(readersMap.get(id) ?? [])],
      delivery_blocks: blocks.filter((block) => block.message_id === id).map(({ agent_user_id, reason }) => ({ agent_user_id, reason })),
    })
  }
  return out
}

// @@@msg-cache (#621/P2/#947) - re-query the cached window's rows from messages_view with the SAME deleted
// filters getMessages uses, chunked like the overlay fetch. Ids absent from the result were deleted
// (globally or for this user); ids present carry their current mutable body fields (content /
// content_type / retracted_at). This is a metadata sweep over already-known ids — never a body refetch
// of new messages. Fail-soft per chunk: an errored chunk is skipped and its ids treated as present
// (unknown) so a transient error never deletes cached rows.
async function loadWindowBodyMutations(
  messageIds: string[],
  userId: string
): Promise<{ mutations: Map<string, MessageMutationPatch>; presentIds: Set<string> }> {
  const mutations = new Map<string, MessageMutationPatch>()
  const presentIds = new Set<string>()
  if (messageIds.length === 0) return { mutations, presentIds }
  for (let i = 0; i < messageIds.length; i += OVERLAY_IN_CHUNK) {
    const chunk = messageIds.slice(i, i + OVERLAY_IN_CHUNK)
    const { data, error } = await chatDb
      .from('messages_view')
      .select(MESSAGES_VIEW_SELECT)
      .in('id', chunk)
      .is('deleted_at', null)
      .eq('is_imported_history_root', false)
      .not('deleted_for_user_ids', 'cs', JSON.stringify([userId]))
    if (error) {
      console.warn(
        `[chat] window body revalidation failed (offset ${i}/${messageIds.length}): ${error.message}`
      )
      // Skip this chunk — treat its ids as present (unknown) so a transient error never deletes rows.
      for (const id of chunk) presentIds.add(id)
      continue
    }
    // Reuse the canonical row mapper, then keep only the mutable body fields (content / content_type /
    // retracted_at). Ids that map to null (missing id/chat/sender) are simply skipped.
    for (const raw of (data ?? []) as RawMessageRow[]) {
      const item = messageItemFromRow(raw, userId)
      if (!item) continue
      presentIds.add(item.id)
      mutations.set(item.id, {
        content: item.content,
        content_type: item.content_type,
        retracted_at: item.retracted_at,
      })
    }
  }
  return { mutations, presentIds }
}

export async function applyMessageOverlays(items: MessageItem[], userId: string): Promise<MessageItem[]> {
  const overlays = await loadMessageOverlays(
    items.map((m) => m.id),
    userId
  )
  return items.map((m) => ({
    ...m,
    ...(overlays.get(m.id) ?? { reactions: [], delivered: false, delivery_status: null, readers: [] }),
  }))
}

export async function revalidateMessageWindow(
  messageIds: string[],
  userId: string
): Promise<WindowRevalidation> {
  const [overlays, { mutations, presentIds }] = await Promise.all([
    loadMessageOverlays(messageIds, userId),
    loadWindowBodyMutations(messageIds, userId),
  ])
  return { overlays, mutations, presentIds }
}
