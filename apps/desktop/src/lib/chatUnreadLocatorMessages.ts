import { messageItemFromRow, MESSAGES_VIEW_SELECT, type RawMessageRow } from '@gugu/core/cloud/messageItem'
import type { ChatUnreadLocator, MessageItem } from '@gugu/core/shared/types/chat'
import { applyMessageOverlays } from './chatMessageRevalidation'
import { chatDb } from './supabase'
import { requireThreadCapableChat } from './chatThreadGate'
import { UNREAD_LOCATOR_ANCHOR_PAGE, UNREAD_LOCATOR_FORWARD_PAGE } from './chatUnreadLocatorWindow'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type OpenableLocator = ChatUnreadLocator & { message_id: string; message_seq: number }

export type UnreadLocatorWindowPages = {
  /** `seq <= 锚点` 的最近一页，正序，必定含锚点本身。 */
  anchorRows: MessageItem[]
  /** `seq > 锚点` 的最早一页，正序。 */
  forwardRows: MessageItem[]
  /** forward 查询的**原始行数**没取满它的 limit ⇒ 锚点之后已取尽 ⇒ 窗口够到 stream 尾部。 */
  reachedTail: boolean
  /** 这条 stream 对本人可见的**最大 seq**：read cursor 的上界，与窗口取到哪儿无关（#6089）。 */
  tailSeq: number
}

// 三个查询（锚点页 / forward 页 / 尾部）逐字共用这条边界：尾部若按另一套算，会把看不见的消息标成已读。
function streamVisibilityFilter(chatId: string, locator: OpenableLocator, userId: string, select: string) {
  const query = chatDb.from('messages_view').select(select)
    .eq('chat_id', chatId).is('deleted_at', null)
    .not('deleted_for_user_ids', 'cs', JSON.stringify([userId]))
  return locator.stream_kind === 'main'
    ? query.is('thread_root_id', null).eq('is_imported_history_root', false)
    : query.or(`id.eq.${locator.thread_root_id},thread_root_id.eq.${locator.thread_root_id}`)
}

// 一条 stream 的一页。rowCount 与 items 分开报：messageItemFromRow 丢掉畸形行，拿映射后的条数判
// 「取没取满」会把满页误读成短页（#4258 review）。
async function readLocatorStreamPage(
  chatId: string,
  locator: OpenableLocator,
  userId: string,
  page: { direction: 'anchor' | 'forward'; limit: number },
): Promise<{ items: MessageItem[]; rowCount: number }> {
  const ascending = page.direction === 'forward'
  const scoped = streamVisibilityFilter(chatId, locator, userId, MESSAGES_VIEW_SELECT)
  const query = ascending ? scoped.gt('seq', locator.message_seq) : scoped.lte('seq', locator.message_seq)
  const { data, error } = await query.order('seq', { ascending }).limit(page.limit)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as RawMessageRow[]
  const items = rows
    .map((row) => messageItemFromRow(row, userId))
    .filter((message): message is MessageItem => message !== null)
  return { items: ascending ? items : items.reverse(), rowCount: rows.length }
}

// @@@6089 read cursor 的上界（一次 1 行查询，理由见 chatUnreadLocatorWindow.ts 文件头）。
// ❌ 不拿 `chats.next_message_seq-1` 顶替：它还计入本人看不见的消息（whisper / 已删 / 导入历史 root）。
async function readStreamTailSeq(chatId: string, locator: OpenableLocator, userId: string): Promise<number> {
  const { data, error } = await streamVisibilityFilter(chatId, locator, userId, 'seq').order('seq', { ascending: false }).limit(1)
  if (error) throw new Error(error.message)
  // web 目标下 `select('seq')` 推不出 `{ seq: number }` ⇒ 先过 unknown 再当场验；❌ 别退回 0（水位会悄悄回退）。
  const seq = Number(((data ?? []) as unknown as Array<{ seq?: unknown }>)[0]?.seq)
  if (!Number.isFinite(seq)) throw new Error(`Unread locator stream ${locator.stream_id} has no visible tail`)
  return seq
}

/**
 * locator 打开要的整扇窗口：锚点两侧各一页有界数据（锚点是窗口下界，不是上界 —— 见 #4258，规则在
 * chatUnreadLocatorWindow.ts 的文件头）。两页按锚点互补切分同一条可见性边界，所以拼起来必然连续；
 * 校验与 thread 能力门只做一次，overlay 也只对合并后的窗口取一次（而不是每页各来一趟）。
 */
export async function getUnreadLocatorWindow(
  chatId: string,
  locator: OpenableLocator,
  userId: string,
  pages: { anchor?: number; forward?: number } = {},
): Promise<UnreadLocatorWindowPages> {
  // Message ids are TEXT at the chat boundary. Imported and idempotent messages can use
  // stable non-UUID ids; only thread roots still require UUIDs because that stream contract
  // names a persisted root identity.
  if (typeof locator.message_id !== 'string' || locator.message_id.trim() === '') {
    throw new Error(`getUnreadLocatorWindow: invalid message id ${JSON.stringify(locator.message_id)}`)
  }
  const expectedStream = locator.stream_kind === 'main'
    ? `main:${chatId}`
    : `thread:${chatId}:${locator.thread_root_id ?? ''}`
  if (locator.stream_id !== expectedStream || (locator.stream_kind === 'thread' && !UUID_RE.test(locator.thread_root_id ?? ''))) {
    throw new Error(`getUnreadLocatorWindow: invalid stream ${JSON.stringify(locator.stream_id)}`)
  }
  if (locator.stream_kind === 'thread') await requireThreadCapableChat(chatId, 'getUnreadLocatorWindow')

  const forwardLimit = pages.forward ?? UNREAD_LOCATOR_FORWARD_PAGE
  // 尾部与两页并发取（同一瞬间的库）；取完之后到达的是真的新消息，经 realtime 照常落进未读。
  const [anchorPage, forwardPage, tailSeq] = await Promise.all([
    readLocatorStreamPage(chatId, locator, userId, { direction: 'anchor', limit: pages.anchor ?? UNREAD_LOCATOR_ANCHOR_PAGE }),
    readLocatorStreamPage(chatId, locator, userId, { direction: 'forward', limit: forwardLimit }),
    readStreamTailSeq(chatId, locator, userId),
  ])
  if (!anchorPage.items.some((message) => message.id === locator.message_id && message.seq === locator.message_seq)) {
    throw new Error(`Unread locator message ${locator.message_id} is not visible in ${locator.stream_id}`)
  }
  const overlaid = await applyMessageOverlays([...anchorPage.items, ...forwardPage.items], userId)
  return {
    anchorRows: overlaid.slice(0, anchorPage.items.length),
    forwardRows: overlaid.slice(anchorPage.items.length),
    // limit 与「取没取满」的判定在同一处，两者不会各自漂移成两个独立默认值。
    reachedTail: forwardPage.rowCount < forwardLimit,
    tailSeq,
  }
}
