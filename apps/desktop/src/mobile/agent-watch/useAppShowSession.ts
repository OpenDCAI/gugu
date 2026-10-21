import { useEffect, useRef, useState } from 'react'
import { APP_SHOW_SESSION_EVENT, type AppShowSessionDetail } from '@/session/shared/extensions/app-runtime-protocol'

/**
 * `gugu.showSession(id)` on the phone: an App named a session its host found in the task tab's list
 * (`APP_SHOW_SESSION_EVENT`). The shell brings the task tab forward (`toTasks`); the row comes back for the task tab to
 * open as a tap on it does (`AgentWatchPage`'s `openRequest`) — each request a new object, so the same session asked
 * twice opens twice.
 */
export function useAppShowSession(toTasks: () => void): AppShowSessionDetail | null {
  const [request, setRequest] = useState<AppShowSessionDetail | null>(null)
  const toTasksRef = useRef(toTasks)
  toTasksRef.current = toTasks
  useEffect(() => {
    const show = (event: Event) => {
      const detail = (event as CustomEvent<AppShowSessionDetail>).detail
      if (!detail) return
      toTasksRef.current()
      setRequest({ ...detail })
    }
    window.addEventListener(APP_SHOW_SESSION_EVENT, show)
    return () => window.removeEventListener(APP_SHOW_SESSION_EVENT, show)
  }, [])
  return request
}
