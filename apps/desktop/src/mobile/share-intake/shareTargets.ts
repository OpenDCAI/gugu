import type { ChatItem } from '@gugu/core/shared/types/chat'
import { appendToDraft, type DraftAttachment } from '../../store/chatContext'
import { inferAttachmentKind } from '@gugu/core/shared/ui/attachmentModels'
import { compareChatsByActivityDesc, isChatListed } from '@gugu/core/shared/ui/chatModels'

/**
 * 「发送到」页的会话列表(product spec)。列不列用会话列表同一个判据(isChatListed);
 * 搜索是一次指名道姓,照会话列表的规矩不受它约束。话题不在这里:它挂在来源线底下,不是一条平级的会话
 * (product spec)。置顶在前,其余按活动时间。
 */
export function shareTargetChats(
  chats: ChatItem[],
  context: { query: string; displayName: (chat: ChatItem) => string; activeChatId: string | null; drafts: Record<string, string> },
): ChatItem[] {
  const query = context.query.trim().toLocaleLowerCase()
  return chats
    .filter((chat) => chat.kind !== 'topic')
    .filter((chat) => query
      ? context.displayName(chat).toLocaleLowerCase().includes(query)
      : isChatListed(chat, { activeChatId: context.activeChatId, hasDraft: Boolean(context.drafts[chat.id]?.trim()) }))
    .sort((a, b) => Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned)) || compareChatsByActivityDesc(a, b))
}

/**
 * 分享进来的内容接到那条会话已有的草稿后面:文字另起一行,附件排在已排队的后面。❌ 覆盖用户没发出去的草稿。
 */
export function mergeShareIntoDraft(
  draft: { text: string; attachments: DraftAttachment[] },
  share: { text: string | null; files: File[] },
  newId: () => string,
): { text: string; attachments: DraftAttachment[] } {
  const text = share.text ? appendToDraft(draft.text, share.text) : draft.text
  const added = share.files.map((file) => ({ id: newId(), file, kind: inferAttachmentKind(file) }))
  return { text, attachments: [...draft.attachments, ...added] }
}
