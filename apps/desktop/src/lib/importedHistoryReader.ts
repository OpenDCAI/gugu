import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import { getChatKind } from './chatThreadGate'
import { chatDb } from './supabase'
import {
  classifyImportedHistoryClientMessageId,
  IMPORTED_HISTORY_ROOT_PREFIX,
  IMPORTED_HISTORY_TURN_PREFIX,
  isImportedHistoryUuid,
  type ImportedHistoryMarker,
} from '@gugu/core/shared/importedHistoryMarkers'

export { IMPORTED_HISTORY_ROOT_PREFIX, IMPORTED_HISTORY_TURN_PREFIX }
export const IMPORTED_HISTORY_PAGE_SIZE = 500
const IMPORTED_HISTORY_MAX_PAGES = 200

type ImportedHistoryRawRow = {
  id?: unknown
  chat_id?: unknown
  sender_user_id?: unknown
  seq?: unknown
  content?: unknown
  content_type?: unknown
  client_message_id?: unknown
  thread_root_id?: unknown
  is_thread_root?: unknown
  created_at?: unknown
}

export interface ImportedHistoryTurn {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  seq: number
}

export interface ImportedSessionHistory {
  rootId: string
  title: string
  createdAt: string
  turns: ImportedHistoryTurn[]
}

type ImportedHistoryRoot = {
  rootId: string
  title: string
  createdAt: string
  seq: number
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`imported-history row requires ${field}`)
  }
  return value
}

function requiredSeq(value: unknown): number {
  const seq = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(seq)) throw new Error('imported-history row requires numeric seq')
  return seq
}

function marker(value: unknown): ImportedHistoryMarker | null {
  const kind = classifyImportedHistoryClientMessageId(value)
  if (kind) return kind
  if (typeof value === 'string' && value.startsWith(IMPORTED_HISTORY_ROOT_PREFIX)) {
    throw new Error('invalid imported-history root marker')
  }
  if (typeof value === 'string' && value.startsWith(IMPORTED_HISTORY_TURN_PREFIX)) {
    throw new Error('invalid imported-history turn marker')
  }
  return null
}

export function groupImportedHistoryRows(
  rows: unknown[],
  chatId: string,
  ownerUserId: string,
  peerUserId: string,
): ImportedSessionHistory[] {
  const roots = new Map<string, ImportedHistoryRoot>()
  const turns: Array<{ rootId: string; row: ImportedHistoryRawRow }> = []
  const rowIds = new Set<string>()

  for (const value of rows) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const row = value as ImportedHistoryRawRow
    const kind = marker(row.client_message_id)
    if (!kind) continue
    if (requiredText(row.chat_id, 'chat_id') !== chatId) {
      throw new Error('imported-history query returned a row from another chat')
    }

    const id = requiredText(row.id, 'id')
    if (rowIds.has(id)) throw new Error(`duplicate imported-history row ${id}`)
    rowIds.add(id)
    if (row.content_type !== 'text') throw new Error(`invalid imported-history content_type for ${id}`)
    if (kind === 'root') {
      if (row.thread_root_id !== null || row.is_thread_root !== true) {
        throw new Error(`invalid imported-history root ${id}`)
      }
      if (requiredText(row.sender_user_id, 'root sender_user_id') !== ownerUserId) {
        throw new Error(`invalid imported-history root sender for ${id}`)
      }
      if (roots.has(id)) throw new Error(`duplicate imported-history root ${id}`)
      roots.set(id, {
        rootId: id,
        title: requiredText(row.content, 'root content'),
        createdAt: requiredText(row.created_at, 'created_at'),
        seq: requiredSeq(row.seq),
      })
      continue
    }

    if (row.is_thread_root !== false) throw new Error(`invalid imported-history turn ${id}`)

    turns.push({
      rootId: requiredText(row.thread_root_id, 'turn thread_root_id'),
      row,
    })
  }

  const grouped = new Map<string, ImportedHistoryTurn[]>()
  for (const { rootId, row } of turns) {
    const root = roots.get(rootId)
    if (!root) throw new Error(`orphan imported-history turn ${requiredText(row.id, 'id')}`)
    const senderUserId = requiredText(row.sender_user_id, 'turn sender_user_id')
    if (senderUserId !== ownerUserId && senderUserId !== peerUserId) {
      throw new Error(`imported-history turn has unexpected sender ${senderUserId}`)
    }
    const groupedTurns = grouped.get(rootId) ?? []
    // 导入的原话里,咕咕投递进去的那几轮带着信封:面板上只画正文,与会话页的投递卡同一个读方。
    const content = requiredText(row.content, 'turn content')
    groupedTurns.push({
      id: requiredText(row.id, 'id'),
      role: senderUserId === ownerUserId ? 'user' : 'assistant',
      content: readDeliveryEnvelope(content)?.body ?? content,
      createdAt: requiredText(row.created_at, 'created_at'),
      seq: requiredSeq(row.seq),
    })
    grouped.set(rootId, groupedTurns)
  }

  return Array.from(roots.values())
    .sort((a, b) => b.seq - a.seq)
    .map((root) => ({
      rootId: root.rootId,
      title: root.title,
      createdAt: root.createdAt,
      turns: (grouped.get(root.rootId) ?? []).sort((a, b) => a.seq - b.seq),
    }))
}

async function loadDmPeerUserId(chatId: string, ownerUserId: string): Promise<string> {
  const { data, error } = await chatDb
    .from('chat_members')
    .select('user_id')
    .eq('chat_id', chatId)
    .neq('user_id', ownerUserId)
    .limit(2)
  if (error) throw new Error(error.message)
  if (!Array.isArray(data) || data.length !== 1) {
    throw new Error(`loadImportedSessionHistories: ${chatId} requires exactly one DM peer`)
  }
  return requiredText((data[0] as { user_id?: unknown }).user_id, 'DM peer user_id')
}

type ImportedHistoryPageKey = { id: string; seq: number }

function assertStablePageRow(
  value: unknown,
  previous: ImportedHistoryPageKey | null,
  seenIds: Set<string>,
): ImportedHistoryPageKey {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('imported-history pagination returned a malformed row')
  }
  const row = value as ImportedHistoryRawRow
  const id = requiredText(row.id, 'id')
  if (!isImportedHistoryUuid(id)) throw new Error(`imported-history row requires UUID id: ${id}`)
  const seq = requiredSeq(row.seq)
  if (seenIds.has(id)) throw new Error(`duplicate imported-history row ${id}`)
  if (previous && (seq < previous.seq || (seq === previous.seq && id <= previous.id))) {
    throw new Error(`imported-history pagination order is inconsistent at ${id}`)
  }
  seenIds.add(id)
  return { id, seq }
}

async function loadVisibleImportedHistoryRows(chatId: string, ownerUserId: string): Promise<unknown[]> {
  const rows: unknown[] = []
  const seenIds = new Set<string>()
  let previous: ImportedHistoryPageKey | null = null

  for (let page = 0; page < IMPORTED_HISTORY_MAX_PAGES; page += 1) {
    let query = chatDb
      .from('messages')
      .select('id, chat_id, sender_user_id, seq, content, content_type, client_message_id, thread_root_id, is_thread_root, created_at')
      .eq('chat_id', chatId)
      .is('deleted_at', null)
      .not('deleted_for_user_ids', 'cs', JSON.stringify([ownerUserId]))
      .like('client_message_id', 'session-import-%')
      .order('seq', { ascending: true })
      .order('id', { ascending: true })
    if (previous) {
      query = query.or(`seq.gt.${previous.seq},and(seq.eq.${previous.seq},id.gt.${previous.id})`)
    }
    const { data, error } = await query.limit(IMPORTED_HISTORY_PAGE_SIZE)
    if (error) throw new Error(error.message)
    if (!Array.isArray(data)) throw new Error('imported-history pagination returned non-array data')
    if (data.length > IMPORTED_HISTORY_PAGE_SIZE) {
      throw new Error('imported-history pagination returned an oversized page')
    }
    for (const row of data) {
      previous = assertStablePageRow(row, previous, seenIds)
      rows.push(row)
    }
    if (data.length < IMPORTED_HISTORY_PAGE_SIZE) return rows
  }

  throw new Error(`imported-history pagination exceeded ${IMPORTED_HISTORY_MAX_PAGES} pages`)
}

export async function loadImportedSessionHistories(chatId: string, ownerUserId: string): Promise<ImportedSessionHistory[]> {
  const kind = await getChatKind(chatId, 'loadImportedSessionHistories')
  if (kind === 'group') throw new Error('loadImportedSessionHistories: group chats use the group history surface')
  const ownerId = requiredText(ownerUserId, 'owner user_id')
  const peerUserId = await loadDmPeerUserId(chatId, ownerId)
  const rows = await loadVisibleImportedHistoryRows(chatId, ownerId)
  return groupImportedHistoryRows(rows, chatId, ownerId, peerUserId)
}
