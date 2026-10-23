import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/store/auth'
import { phoneTaskSendKey, readPhoneTaskSend, restorePhoneTaskDraft, retryPhoneTaskSend, subscribePhoneTaskSend, type PhoneTaskComposer, type StoredPhoneTaskSend } from './phoneTaskSend'

/** An unacknowledged request is never replayed just because this component mounted. */
export function PhoneTaskDraftRecovery({ deviceId, sessionId, composer, sending }: {
  deviceId: string
  sessionId: string
  composer: PhoneTaskComposer
  sending: boolean
}) {
  const ownerId = useAuth().user?.id
  const key = ownerId ? phoneTaskSendKey(ownerId, deviceId, sessionId) : null
  const [saved, setSaved] = useState<{ key: string; pending: StoredPhoneTaskSend | null; error: string | null } | null>(null)
  const [retryState, setRetryState] = useState<{ key: string; busy: boolean; error: string | null } | null>(null)
  const currentKey = useRef(key)
  currentKey.current = key
  const restored = useRef<{ key: string; text: string } | null>(null)
  const pending = saved?.key === key ? saved.pending : null
  const error = saved?.key === key ? saved.error : null
  const retrying = retryState?.key === key && retryState.busy
  const retryError = retryState?.key === key ? retryState.error : null

  useEffect(() => () => {
    const injected = restored.current
    const current = composer.getState()
    if (injected?.key === key && current.text === injected.text && !current.attachments?.length) composer.setText('')
    if (currentKey.current === key) currentKey.current = null
  }, [key, composer])

  useEffect(() => {
    if (!ownerId || !key) return
    const refresh = () => {
      try { setSaved({ key, pending: readPhoneTaskSend(ownerId, deviceId, sessionId), error: null }) }
      catch { setSaved({ key, pending: null, error: '读取上次发送的原稿失败，未重新发送。请保留本机记录后重试。' }) }
    }
    refresh()
    const stop = subscribePhoneTaskSend((changed) => { if (changed === key) refresh() })
    const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) refresh() }
    window.addEventListener('storage', onStorage)
    return () => { stop(); window.removeEventListener('storage', onStorage) }
  }, [ownerId, deviceId, sessionId, key])

  useEffect(() => {
    if (pending && key && !sending && !retrying && restorePhoneTaskDraft(composer, pending.text)) restored.current = { key, text: pending.text }
  }, [composer, pending, sending, retrying, key])

  const retry = async () => {
    if (!pending || !key || retrying || sending) return
    const startedFor = key
    setRetryState({ key, busy: true, error: null })
    try {
      await retryPhoneTaskSend(ownerId!, deviceId, sessionId, pending.id)
      if (currentKey.current !== startedFor) return
      const current = composer.getState()
      if (current.text === pending.text && !current.attachments?.length) composer.setText('')
    } catch (cause) {
      if (currentKey.current === startedFor) setRetryState({ key: startedFor, busy: false, error: cause instanceof Error ? cause.message : '尚未确认接收，请重试原消息。' })
    } finally {
      if (currentKey.current === startedFor) setRetryState((current) => current?.key === startedFor ? { ...current, busy: false } : current)
    }
  }

  if ((!pending && !error) || (sending && !retrying)) return null
  return (
    <div className="gg-aw-action-error" data-testid="phone-task-draft-recovery">
      {error ? <p role="alert">{error}</p> : (
        <>
          <p role="status">上次发送尚未确认，先重试原消息。已有的新输入会保留。</p>
          <details>
            <summary>查看原消息</summary>
            <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words" data-testid="phone-task-recovered-text">{pending!.text}</div>
          </details>
          <Button size="sm" disabled={sending || retrying} data-testid="phone-task-retry-original" onClick={() => void retry()}>{retrying ? '正在重试' : '重试原消息'}</Button>
          {retryError && <p role="alert">{retryError}</p>}
        </>
      )}
    </div>
  )
}
