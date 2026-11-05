import { messageItemFromRow, type RawMessageRow } from '@gugu/core/cloud/messageItem'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { ingestMessagePage } from './messageIngest'
import { applyMessageOverlays } from './chatMessageRevalidation'

/** Canonical network rows enter the store before a caller can publish them to a view. */
export async function ingestFetchedMessagePage(raw: RawMessageRow[], userId: string, page: {
  chatId: string; limit: number; beforeSeq?: number; afterSeq?: number; threadRootId?: string
}): Promise<MessageItem[]> {
  let rows = raw.map(row => messageItemFromRow(row, userId)).filter((row): row is MessageItem => row !== null)
  if (page.afterSeq === undefined) rows.reverse()
  if (page.threadRootId) rows = await applyMessageOverlays(rows, userId)
  await ingestMessagePage(userId, rows, page.chatId, page.limit, page.beforeSeq, page.afterSeq, page.threadRootId ?? null, raw.length)
  return rows
}
