import type { MessageItem } from '@gugu/core/shared/types/chat'

// @@@chat-window (#504) - cap the in-memory message window. A long-open chat (realtime appending all
// @@@small-window (#946 回港 #4644/#5b) - cap initial render/cache to ~tens, not hundreds:Virtuoso 首屏过取
// 几百条导致卡顿,首屏窗口降到 ~tens(at-tail render/cache cap;MAX_WINDOW 随之 120)。
export const MESSAGE_WINDOW = 40
// @@@chat-isolation - when scrolled up reading older history (loadOlder), allow the
// list to grow up to MAX_WINDOW. ChatHistoryWindow moves this bounded range in both directions,
// preserving retained message indices. Non-active chats trim to MESSAGE_WINDOW; the active window opens
// at MESSAGE_WINDOW and, while following the tail, grows up to MAX_WINDOW and then slides (never shrinks in bulk).
export const MAX_WINDOW = MESSAGE_WINDOW * 3
export const OLDER_PAGE = 60
// @@@small-window (#946 回港 #4644/#5b) - cold-open 只取这么多(vs getMessages 默认 60),约束首屏请求+渲染到
// ~tens。hasMoreOlder 以此为准(取满一整页 ⇒ 还有更旧)。loadOlder/toggleReaction 走默认,不受影响。
export const INITIAL_PAGE = 30
// @@@msg-cache-incremental (#621) - max NEW messages fetched in one incremental gap-heal (seq > maxSeq).
// A chat away for a long time could accrue many; page ceiling matches the older-history page.
export const NEWER_PAGE = 200

export function trimToMessageWindow(messages: MessageItem[]): MessageItem[] {
  return messages.length > MESSAGE_WINDOW ? messages.slice(messages.length - MESSAGE_WINDOW) : messages
}

// 窗口(缓存)已落定行的最大 seq。seq 从 1 起(004_chat_extensions.sql:next_message_seq DEFAULT 1、
// RETURNING next-1),所以 0 = 「没有已验证尾」;乐观行(seq<0)不参与。#621 spine 与 @@@4439 跳号
// 判定共用这一份扫描,❌ 别再各写一份(哨兵语义分叉过一次:-1 哨兵基于「seq 0-based」的过时注释,
// 让首条消息 seq=1 被误判成跳号)。
export function maxMainlineSeq(rows: readonly MessageItem[] | undefined): number {
  let max = 0
  for (const m of rows ?? []) if (m.seq > max) max = m.seq
  return max
}

// @@@4439 ack-seq-jump — 判定一条权威单行合并是否越过了窗口的「已验证连续尾」,返回需要重验证的
// 游标(合并前旧尾),无跳号返回 null。realtime heal 与冷启增量都拿窗口 max seq 当已验证连续尾;
// 权威 ack/附件回读这类单行摄入的 seq 若比旧尾大超过 1,说明服务端在两者之间还落了本窗口没取过的
// 行(交错入站),不重验证它就会永久沉到游标下方(#4439:DB 有行,前端不渲染)。seq 从 1 起 ⇒
// 空窗口(哨兵 0)+ 首条消息(seq 1)没有可越区间,不触发;空窗口 + seq≥2 才是真跳号(新会话首轮
// 交错:入站 seq 1 落库在先、己方 ack seq 2 抢先合并,正是要修的形态)。
export function seqJumpRepairCursor(windowRows: readonly MessageItem[] | undefined, ackedSeq: number): number | null {
  if (ackedSeq < 0) return null
  const prevMax = maxMainlineSeq(windowRows)
  return ackedSeq > prevMax + 1 ? prevMax : null
}
