import { useEffect, useRef } from 'react'
import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
import { useAppActive } from '@/lib/onScreenChat'
import { chatSeq, writeRead } from '@/lib/readWriter'
import { rendererLogger } from '@/lib/log'

/** Reaching the native task's tail has the same DM read meaning as opening the ordinary DM at its tail. */
export function useNativeDmTailRead({ chat, messages, loading, hasNewer, atTail, refresh }: {
  chat: ChatItem
  messages: readonly MessageItem[]
  loading: boolean
  hasNewer: boolean
  atTail: boolean | undefined
  refresh: () => Promise<void>
}): void {
  const active = useAppActive()
  // This opening owns this watermark only. Replies or a new manual unread intent arriving later stay outside it.
  const opening = useRef({ seq: chat.next_message_seq - 1, version: chat.read_state_version ?? 0, sent: false })
  useEffect(() => {
    const captured = opening.current
    if (captured.sent || !active || !atTail || loading || hasNewer || captured.seq <= 0
      || (chat.is_marked_unread && (chat.read_state_version ?? 0) !== captured.version)
      || (chat.last_read_seq >= captured.seq && !chat.is_marked_unread)
      || !messages.some(message => message.seq >= captured.seq)) return
    captured.sent = true
    void writeRead({ kind: 'main', chatId: chat.id, seq: chatSeq(captured.seq) })
      .then(refresh)
      .catch(error => rendererLogger('chat/native-tail-read').warn({ chatId: chat.id, error: String(error) }, 'Native conversation tail could not be acknowledged'))
  }, [active, atTail, loading, hasNewer, messages, chat, refresh])
}
