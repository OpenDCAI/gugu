import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { deriveReadReceipt } from '@gugu/core/shared/ui/messageState'
import type { MemberProfileCardModel } from '@/components/MemberProfileCard'
import type { ReadReceiptMember } from '@/components/ReadReceiptPopover'

/** 主线和话题共用名单派生；消息和读位必须来自当前这条会话。 */
export function useReadReceiptPanel({ chatId, messages, memberReadSeqs, memberProfiles }: {
  chatId: string | null
  messages: readonly MessageItem[]
  memberReadSeqs: Record<string, number>
  memberProfiles: Record<string, MemberProfileCardModel>
}) {
  const [selection, setSelection] = useState<{ chatId: string; messageId: string; anchor: Element } | null>(null)
  useEffect(() => { setSelection(null) }, [chatId])

  const onShowReadReceipt = useCallback((messageId: string, anchor: HTMLElement) => {
    if (chatId) setSelection({ chatId, messageId, anchor })
  }, [chatId])
  const onCloseReadReceipt = useCallback(() => { setSelection(null) }, [])
  const readReceiptPanel = useMemo(() => {
    if (!selection || selection.chatId !== chatId) return null
    const message = messages.find((item) => item.id === selection.messageId)
    if (!message || message.retracted_at) return null
    const receipt = deriveReadReceipt(message, memberReadSeqs, {
      messageReaders: message.readers?.length ? { [message.id]: new Set(message.readers) } : {},
    })
    const toMember = (id: string): ReadReceiptMember => {
      const profile = memberProfiles[id]
      return { id, displayName: profile?.displayName ?? id, avatar: profile?.avatar ?? null, isAgent: profile?.type === 'agent' }
    }
    const readers = new Set(receipt.readerIds)
    return {
      anchor: selection.anchor,
      readers: receipt.readerIds.map(toMember),
      unreaders: receipt.recipientIds.filter((id) => !readers.has(id)).map(toMember),
    }
  }, [selection, chatId, messages, memberReadSeqs, memberProfiles])

  return { readReceiptPanel, onShowReadReceipt, onCloseReadReceipt }
}
