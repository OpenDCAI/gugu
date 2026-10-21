import type { MessageItem } from '@gugu/core/shared/types/chat'
import { mergeMessagesById } from '@gugu/core/shared/ui/messageListModels'
import { readMessageWindow, type AccountImRepository } from '../lib/imRepository'
import { trimToMessageWindow } from './chatMessageWindow'

/**
 * 盘上(L2)的消息窗 → 这条会话现在就能画的行。盘读是同步的:仓库开着时,点开一条会话的**同一帧**
 * 就把上次的内容画出来,而不是先画一帧骨架/空态再等下一拍 —— 那一帧就是用户看到的「一闪」。
 *
 * - 按 chat_id 过滤 + 裁到窗口(防串会话,与内存缓存同一契约)。
 * - 内存里只有未落定的乐观行(outbox)不算已缓存:与盘上的窗合并。
 * - 内存里已有落定行 ⇒ null:更新的网络数据优先,迟到的盘读不许覆盖它。
 */
export function paintableDiskWindow(repository: AccountImRepository, chatId: string, live: MessageItem[] | undefined): { rows: MessageItem[]; hasMoreOlder: boolean } | null {
  if (live?.some((message) => message.seq >= 0)) return null
  const cached = readMessageWindow(repository, chatId)
  const rows = cached ? trimToMessageWindow(cached.messages.filter((message) => message.chat_id === chatId)) : []
  if (!cached || rows.length === 0) return null
  return { rows: trimToMessageWindow(mergeMessagesById(live ?? [], rows, chatId)), hasMoreOlder: cached.hasMoreOlder }
}

/** 盘上的窗能画就写进内存缓存(同一份判定),返回写进去的那份;画不了返回 null、缓存不动。 */
export function seedCacheFromDisk(cache: Map<string, MessageItem[]>, repository: AccountImRepository, chatId: string): { rows: MessageItem[]; hasMoreOlder: boolean } | null {
  const disk = paintableDiskWindow(repository, chatId, cache.get(chatId))
  if (disk) cache.set(chatId, disk.rows)
  return disk
}
