import { useCallback, useLayoutEffect, useRef, useState, type SetStateAction } from 'react'
import { useChatDraft } from '@/components/chat/useChatDraft'
import { readNativeOfflineDraft, writeNativeOfflineDraft } from '@/lib/nativeOfflineDraft'
import { useSessionInputAccount } from '@/lib/sessionInputOutboxBridge'
import { appendToDraft } from '@/store/chatContext'

const flushed = () => {}

/** Desktop native timelines hand the same durable text to ACP; phone drafts keep their existing store. */
export function useSessionConversationDraft(deviceId: string, sessionId: string, nativeOffline: boolean) {
  const chat = useChatDraft(`session:${deviceId}/${sessionId}`)
  const account = useSessionInputAccount()
  const key = `${account}/${deviceId}/${sessionId}`
  const [kept, setKept] = useState(() => ({ key, text: nativeOffline ? readNativeOfflineDraft(deviceId, sessionId) : '' }))
  const current = useRef(kept)
  useLayoutEffect(() => {
    if (!nativeOffline || !account) return
    // Consume an older desktop timeline draft once, so ACP cannot leave a stale second copy behind.
    const stored = readNativeOfflineDraft(deviceId, sessionId)
    const text = chat.text ? appendToDraft(stored, chat.text) : stored
    if (chat.text) {
      writeNativeOfflineDraft(deviceId, sessionId, text)
      chat.setText(''); chat.flush()
    }
    const next = { key, text }
    current.current = next; setKept(next)
  }, [nativeOffline, account, key, deviceId, sessionId, chat.text, chat.setText, chat.flush])
  const setText = useCallback((update: SetStateAction<string>) => {
    const previous = current.current.key === key ? current.current.text : readNativeOfflineDraft(deviceId, sessionId)
    const text = typeof update === 'function' ? update(previous) : update
    writeNativeOfflineDraft(deviceId, sessionId, text)
    current.current = { key, text }; setKept(current.current)
  }, [key, deviceId, sessionId])
  return nativeOffline ? {
    text: kept.key === key ? kept.text : readNativeOfflineDraft(deviceId, sessionId),
    setText,
    // Native text is persisted synchronously by the existing nativeOfflineDraft writer.
    flush: flushed,
  } : chat
}
