import { useEffect, useRef } from 'react'
import { useAppActive } from '@/lib/onScreenChat'
import { readOwnerNotificationSnapshot, writeRead, type NativeItemId } from '@/lib/readWriter'
import { rendererLogger } from '@/lib/log'

/** Opening owns only this snapshot of explicit notifications, independently of transcript loading and scrolling. */
export function useOwnerNotificationRead(deviceId: string | null, sessionId: string | undefined, shown: boolean, supported: boolean): void {
  const appActive = useAppActive()
  const opening = useRef({ deviceId, sessionId, shown, pending: null as Set<NativeItemId> | null,
    snapshot: null as Promise<readonly NativeItemId[] | undefined> | null })
  if (opening.current.deviceId !== deviceId || opening.current.sessionId !== sessionId || (shown && !opening.current.shown)) {
    opening.current = { deviceId, sessionId, shown, pending: null, snapshot: null }
  }
  opening.current.shown = shown
  useEffect(() => {
    if (!shown || !sessionId || !appActive || !supported) return
    const captured = opening.current
    let active = true
    let busy = false
    // Read the live browser state again after an asynchronous host reply; it may have changed meanwhile.
    const canRead = () => active && opening.current === captured && captured.shown
      && document.visibilityState !== 'hidden' && document.hasFocus()
    const flush = async () => {
      if (busy || !canRead()) return
      busy = true
      try {
        if (captured.pending === null) {
          const snapshot = await (captured.snapshot ??= readOwnerNotificationSnapshot(deviceId, sessionId))
          // An older host has no owner-only snapshot. Keep its existing visible-message confirmation path.
          if (captured.pending === null) captured.pending = new Set(snapshot ?? [])
        }
        if (!canRead()) return
        const itemIds = [...captured.pending].slice(0, 500)
        if (!itemIds.length) return
        await writeRead({ kind: 'native', deviceId, conversationId: sessionId, itemIds })
        for (const id of itemIds) captured.pending!.delete(id)
      } catch (error) {
        if (captured.pending === null) captured.snapshot = null
        rendererLogger('session/read').warn({ sessionId, error: String(error) }, 'Owner notifications could not be acknowledged')
      } finally { busy = false }
    }
    void flush()
    const timer = setInterval(() => { void flush() }, 500)
    window.addEventListener('focus', flush)
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', flush) }
  }, [deviceId, sessionId, shown, appActive, supported])
}
