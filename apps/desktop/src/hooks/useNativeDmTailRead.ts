import { useEffect, useRef } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { useAppActive } from '@/lib/onScreenChat'
import { chatSeq, writeRead } from '@/lib/readWriter'
import { rendererLogger } from '@/lib/log'

/** Opening the native task page reads its DM whole, like opening any DM (readsWholeChat): scroll position does not matter. */
export function useNativeDmTailRead({ chat, refresh }: { chat: ChatItem; refresh: () => Promise<void> }): void {
  const active = useAppActive()
  // This opening owns this watermark only. Replies or a new manual unread intent arriving later stay outside it.
  const opening = useRef({ seq: chat.next_message_seq - 1, version: chat.read_state_version ?? 0, sent: false })
  useEffect(() => {
    const captured = opening.current
    if (captured.sent || !active || captured.seq <= 0
      || (chat.is_marked_unread && (chat.read_state_version ?? 0) !== captured.version)
      || (chat.last_read_seq >= captured.seq && !chat.is_marked_unread)) return
    captured.sent = true
    void writeRead({ kind: 'main', chatId: chat.id, seq: chatSeq(captured.seq) })
      .then(refresh)
      .catch(error => rendererLogger('chat/native-tail-read').warn({ chatId: chat.id, error: String(error) }, 'Native conversation opening read could not be acknowledged'))
  }, [active, chat, refresh])
}
