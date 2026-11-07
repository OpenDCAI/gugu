import { useEffect, useRef } from 'react'
import { useToast } from '@/components/toastContext'
import { dismissNotice, notify } from '@/lib/notices'
import { messageForUser } from '@/lib/userFacingError'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'

/** Read recovery is automatic; retrying an agent bootstrap remains an explicit user action. */
export function useTimelineFailureNotice(key: string, readError: string | null, startup: {
  error: string | null; busy: boolean; retry: (() => Promise<void>) | null
}) {
  const { toast } = useToast()
  const reported = useRef<{ key: string; kind: 'read' | 'startup' | null }>({ key, kind: null })
  const active = useRef<string | null>(key)
  const latest = useRef(startup.retry)
  latest.current = startup.retry
  const notice = useRef<string | null>(null)
  useEffect(() => {
    active.current = key
    return () => {
      active.current = null
      if (notice.current !== null) dismissNotice(notice.current)
      notice.current = null
    }
  }, [key])
  const error = startup.error ?? readError
  const kind = startup.error && startup.retry ? 'startup' : 'read'
  useEffect(() => {
    if (reported.current.key !== key) { reported.current = { key, kind: null }; return }
    if (!error || startup.busy) {
      reported.current.kind = null
      if (notice.current !== null) dismissNotice(notice.current)
      notice.current = null
      return
    }
    if (reported.current.kind === kind) return
    reported.current.kind = kind
    if (notice.current !== null) dismissNotice(notice.current)
    notice.current = null
    if (kind === 'startup') {
      const noticeKey = `timeline-startup:${crypto.randomUUID()}`
      notice.current = noticeKey
      notify({ key: noticeKey, title: messageForUser(error), tier: 'error', action: {
        label: translateSessionMessage('transcript.condition.restartAgent'),
        onClick: () => { if (active.current === key) void latest.current?.() },
      } })
    } else toast(messageForUser(error), 'error')
  }, [key, error, kind, startup.busy, toast])
}
