import { useEffect, useRef, useState } from 'react'
import type { LifeView } from '@/session/shared/core/sessions/session-life'
import { sessionLifeViewChannel } from '@/session/shared/core/sessions/sessionEvents'
import { onMachineEvent as onLocalMachineEvent } from '@renderer/lib/ipc'
import { machineRpc, onLinkChange, onMachineEvent } from './sessionpage-rpc'
import { messageForUser } from '@/lib/userFacingError'

/** Same host lifecycle as the desktop; subscribe before reading, and release both subscriptions on navigation. */
export function useSessionLifeView(deviceId: string, sessionId: string, local: boolean, enabled: boolean, readInitial = true) {
  const key = `${local ? 'local' : deviceId}/${sessionId}`
  const [snapshot, setSnapshot] = useState<{ key: string; view: LifeView | null; error: string | null }>({ key, view: null, error: null })
  const wantsRead = useRef(readInitial)
  wantsRead.current = readInitial
  const readOnce = useRef(() => {})
  useEffect(() => {
    if (!enabled) return
    let alive = true
    let generation = 0
    let current: LifeView | null = null
    let requested = false
    const accept = (view: LifeView) => {
      if (!alive || view.sessionId !== sessionId || (current && current.version >= view.version)) return
      current = view
      setSnapshot({ key, view, error: null })
    }
    const read = () => {
      const request = ++generation
      void machineRpc(deviceId, local).sessions.lifeView(sessionId).then(view => {
        if (request === generation) accept(view)
      }, (error: unknown) => {
        if (alive && request === generation) setSnapshot({ key, view: current, error: messageForUser(error) })
      })
    }
    const stopEvents = local ? onLocalMachineEvent(null, sessionLifeViewChannel, accept) : onMachineEvent(deviceId, sessionLifeViewChannel, accept)
    const stopLink = local ? () => {} : onLinkChange(deviceId, open => {
      if (!open || (!wantsRead.current && !current?.pending.items.length)) return
      // Host versions restart when its owner restarts. The new link establishes a new ordering epoch.
      current = null
      read()
    })
    readOnce.current = () => { if (!requested) { requested = true; read() } }
    return () => { alive = false; generation++; readOnce.current = () => {}; stopEvents(); stopLink() }
  }, [deviceId, sessionId, local, enabled, key])
  useEffect(() => { if (enabled && readInitial) readOnce.current() }, [enabled, readInitial, key])
  return enabled && snapshot.key === key ? snapshot : { view: null, error: null }
}
