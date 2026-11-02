import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@renderer/lib/ui/button'
import { Textarea } from '@renderer/lib/ui/textarea'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { enqueueSessionInput, useQueuedSessionInputs, useSessionInputAccount } from '@/lib/sessionInputOutboxBridge'
import { readNativeOfflineDraft, writeNativeOfflineDraft } from '@/lib/nativeOfflineDraft'
import { registerNativeComposer } from '@/lib/nativeComposerHandoff'
import { messageForUser } from '@/lib/userFacingError'
import { SessionInputQueue } from './SessionInputQueue'

/** The task page can accept durable input before its remote workspace has ever mounted. */
export function OfflineSessionInput({ deviceId, sessionId, label }: { deviceId: string; sessionId: string; label: string }) {
  const accountId = useSessionInputAccount()
  return accountId ? <OfflineComposer key={`${accountId}/${deviceId}/${sessionId}`} deviceId={deviceId} sessionId={sessionId} label={label} />
    : <div className="flex h-full w-full items-center justify-center text-sm text-foreground-muted">{label}</div>
}
function OfflineComposer({ deviceId, sessionId, label }: { deviceId: string; sessionId: string; label: string }) {
  const { translate } = useSessionMessages()
  const pending = useQueuedSessionInputs(sessionId)
  const [text, setText] = useState(() => readNativeOfflineDraft(deviceId, sessionId))
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const current = useRef(text)
  current.current = text
  const edit = useCallback((text: string) => { writeNativeOfflineDraft(deviceId, sessionId, text); current.current = text; setText(text) }, [deviceId, sessionId])
  useEffect(() => registerNativeComposer(sessionId, draft => {
    if (draft.files?.length) throw new Error('附件草稿已保留，连接恢复后可继续发送')
    edit([current.current, draft.text].filter(Boolean).join('\n'))
  }), [sessionId, edit])
  const send = async () => {
    if (!text.trim() || sending) return
    setSending(true); setError(null)
    try {
      await enqueueSessionInput({ deviceId, sessionId, text })
      if (current.current === text) edit('')
    } catch (error) { setError(messageForUser(error)) }
    finally { setSending(false) }
  }
  return <div className="flex h-full min-h-0 flex-col" data-native-offline-input="">
    <div className="flex flex-1 items-center justify-center p-4 text-sm text-foreground-muted">{pending.length ? null : label}</div>
    <SessionInputQueue sessionId={sessionId} waitingForConnection />
    {error ? <div role="alert" className="px-3 text-sm">{error}</div> : null}
    <div className="p-3">
      <Textarea value={text} onChange={event => edit(event.target.value)} aria-label={translate('composer.sendMessage')} rows={3} disabled={sending} />
      <div className="mt-2 flex justify-end"><Button size="sm" disabled={sending || !text.trim()} onClick={() => { void send() }}>{translate('composer.sendMessage')}</Button></div>
    </div>
  </div>
}
