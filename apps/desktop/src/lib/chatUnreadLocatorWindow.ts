import type { ChatUnreadLocator, MessageItem } from '@gugu/core/shared/types/chat'

// @@@unread-locator-window (#4258) — 一次 locator 打开里，行集与 read cursor 各自的推进规则收在这里。
//
// `unread_locator.message_seq` 是**导航锚点(第一条未读)**，既不是读取水位、也不是窗口上界。#4258 之前把锚点
// 同时当成窗口上界与 cursor：行集停在第一条未读、badge 却前进了一格，第二条未读既不在行集里也够不着。
// ⇒ 锚点是窗口的**下界**，窗口必须跨过它向前延伸；够没够到尾部不做预测、由结果判定（同 #1926/#1888 的
// result-side degrade）：forward 页取满 ⇒ 够不到，`hasNewer` 据此给出「返回最新 / N 条新消息」。
//
// @@@6089 —— **cursor 与窗口是两件事**：cursor 走这条 stream 对本人可见的**尾部 seq**（「打开 = 这条会话我
// 看过了」，#5295「点开就清」+ product spec），窗口有界只是渲染约束。两者从前是同一个数
// ⇒ 未读多于一页时一次清不完、剩下的永远挂在角标上（owner 真机 70 条 → 打开后仍剩 9）。
//
// 「取没取满」必须由**服务端那一页的原始行数**判定：`messageItemFromRow` 丢掉一条畸形行就会把满页读成
// 短页 → 误判够到尾部 → 正好制造这条规则要防的洞。reachedTail 在查询处算好带过来，本模块只消费。

// 两页各自的上限。锚点页(≤60，向下取上文) + forward 页(≤60) = 120 = store 的 MAX_WINDOW：提交后的窗口
// 即便被 ChatHistoryWindow 裁到 MAX_WINDOW 也裁不掉锚点本身（锚点距尾端至多一整个 forward 页）。
export const UNREAD_LOCATOR_ANCHOR_PAGE = 60
export const UNREAD_LOCATOR_FORWARD_PAGE = 60

export type UnreadLocatorCommit = {
  /** 锚点页 + forward 页拼成的连续窗口（两页按锚点互补切分同一 stream，拼接天然无洞）。 */
  rows: MessageItem[]
  /** 本次要提交的 read cursor：这条 stream 对本人可见的尾部 seq（#6089，见文件头）。 */
  readSeq: number
  /** forward 页没取满 ⇒ 锚点之后已取尽 ⇒ 本次窗口覆盖到 stream 尾部。 */
  reachedTail: boolean
}

export function commitUnreadLocatorWindow(input: {
  anchorSeq: number
  /** 该 stream 中 `seq <= anchorSeq` 的最近一页（含锚点本身）。 */
  anchorRows: readonly MessageItem[]
  /** 该 stream 中 `seq > anchorSeq` 的最早一页，正序。 */
  forwardRows: readonly MessageItem[]
  /** 由 forward 查询的原始行数与其 limit 判定，见文件头。 */
  reachedTail: boolean
  /** 该 stream 对本人可见的最大 seq（与两页同一瞬间、同一可见性边界取回）。 */
  tailSeq: number
}): UnreadLocatorCommit {
  // 两页必须严格按锚点互补切分，否则「拼起来就是连续窗口」这个前提不成立 —— 越界即响亮失败，不修剪兜底。
  const strayAnchorRow = input.anchorRows.find((message) => message.seq > input.anchorSeq)
  if (strayAnchorRow) {
    throw new Error(`Unread locator anchor page returned seq ${strayAnchorRow.seq} above anchor ${input.anchorSeq}`)
  }
  const strayForwardRow = input.forwardRows.find((message) => message.seq <= input.anchorSeq)
  if (strayForwardRow) {
    throw new Error(`Unread locator forward page returned seq ${strayForwardRow.seq} at or below anchor ${input.anchorSeq}`)
  }
  // 尾部低于锚点 = 两次查询看的不是同一条 stream ⇒ 响亮失败，❌ 不退回窗口最大值。
  if (input.tailSeq < input.anchorSeq) {
    throw new Error(`Unread locator tail seq ${input.tailSeq} is below anchor ${input.anchorSeq}`)
  }
  const rows = [...input.anchorRows, ...input.forwardRows]
  let readSeq = input.tailSeq // @@@6089 cursor = stream 尾部，不是窗口最大 seq（理由见文件头）。
  for (const message of rows) if (message.seq > readSeq) readSeq = message.seq
  return { rows, readSeq, reachedTail: input.reachedTail }
}

/**
 * 主线与 thread 是两条独立 stream，本地行集的归属按 locator 判：主线只认非话题行，话题只认自己的 root
 * 与它的回复。thread 视图是一个扁平数组、并且 locator 打开这条路**不经过 openThread**（那里才有
 * `setThreadMessages([])` 的清空），所以跨 root 的保留会把上一个话题的回复混进新话题里。
 */
export function belongsToUnreadStream(
  locator: Pick<ChatUnreadLocator, 'stream_kind' | 'thread_root_id'>,
  message: MessageItem,
): boolean {
  return locator.stream_kind === 'main'
    ? message.thread_root_id == null
    : message.id === locator.thread_root_id || message.thread_root_id === locator.thread_root_id
}

/**
 * 本次提交要保留的既有行：先按 stream 归属过滤（见 belongsToUnreadStream），再按是否够到尾部决定已落定行
 * 的去留。在途乐观行（`seq < 0`）永远保留 —— 与 revalidateWindowOverlays / applyThreadSnapshot 同约。
 * 已落定行只在 `reachedTail` 时保留：那时新窗口覆盖 锚点→取数时的尾部，本地窗口要么落在这段区间内、要么
 * 是取数之后 realtime/heal 连续追加的，合并不会留洞。够不到尾部时，本地尾部窗口与本次窗口之间隔着至少
 * 一整页服务端行，保留就是留洞 —— 丢弃它，让窗口严格等于本次取到的那段连续区间（剩余未读仍由服务端
 * badge 与新锚点指着）。
 */
export function selectRetainedStreamRows(
  previous: readonly MessageItem[],
  commit: UnreadLocatorCommit,
  locator: Pick<ChatUnreadLocator, 'stream_kind' | 'thread_root_id'>,
): MessageItem[] {
  return previous.filter((message) => (
    belongsToUnreadStream(locator, message) && (commit.reachedTail || message.seq < 0)
  ))
}
