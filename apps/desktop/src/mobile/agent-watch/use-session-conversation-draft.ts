import { useCallback, useLayoutEffect, useSyncExternalStore, type RefObject, type SetStateAction } from 'react'
import type { PromptEditorRef } from '@gugu/session-ui/react/components'
import { useChatDraft } from '@/components/chat/useChatDraft'
import { readNativeOfflineDraft, subscribeNativeOfflineDraft, writeNativeOfflineDraft } from '@/lib/nativeOfflineDraft'
import { state as sessionInputs, useSessionInputAccount } from '@/lib/sessionInputOutboxBridge'
import { appendToDraft, useChatStore } from '@/store/chatContext'

const flushed = () => {}

/** Desktop native timelines hand the same durable text to ACP; phone drafts keep their existing store. */
export function useSessionConversationDraft(deviceId: string, sessionId: string, nativeOffline: boolean, editor?: RefObject<PromptEditorRef | null>) {
  const chatId = `session:${deviceId}/${sessionId}`
  const chat = useChatDraft(chatId)
  const { writeDraft, registerDraftEditor } = useChatStore('writeDraft', 'registerDraftEditor')
  const { text: chatText, setText: setChatText, flush: flushChat } = chat
  const account = useSessionInputAccount()
  const readNative = useCallback(() => nativeOffline && account ? readNativeOfflineDraft(deviceId, sessionId) : '', [nativeOffline, account, deviceId, sessionId])
  const kept = useSyncExternalStore(subscribeNativeOfflineDraft, readNative, readNative)
  useLayoutEffect(() => {
    if (nativeOffline && account) return
    return registerDraftEditor(chatId, () => editor?.current ?? null)
  }, [nativeOffline, account, chatId, registerDraftEditor, editor])
  useLayoutEffect(() => {
    if (!nativeOffline || !account) return
    // Consume an older desktop timeline draft once, so ACP cannot leave a stale second copy behind.
    const stored = readNativeOfflineDraft(deviceId, sessionId)
    const text = chatText ? appendToDraft(stored, chatText) : stored
    if (chatText) {
      writeNativeOfflineDraft(deviceId, sessionId, text)
      setChatText(''); flushChat()
    }
  }, [nativeOffline, account, deviceId, sessionId, chatText, setChatText, flushChat])
  const setText = useCallback((update: SetStateAction<string>) => {
    const previous = readNativeOfflineDraft(deviceId, sessionId)
    const text = typeof update === 'function' ? update(previous) : update
    writeNativeOfflineDraft(deviceId, sessionId, text)
  }, [deviceId, sessionId])
  const committed = useCallback((submitted: string) => {
    const own = sessionInputs()
    if (!account || own.accountId !== account || !own.valid()) return
    if (nativeOffline && account) {
      if (readNativeOfflineDraft(deviceId, sessionId) === submitted) writeNativeOfflineDraft(deviceId, sessionId, '')
    } else writeDraft(chatId, { clearIf: submitted })
  }, [nativeOffline, account, deviceId, sessionId, chatId, writeDraft])
  return nativeOffline && account ? {
    text: kept, setText, committed,
    // Native text is persisted synchronously by the existing nativeOfflineDraft writer.
    flush: flushed,
  } : { ...chat, committed }
}
