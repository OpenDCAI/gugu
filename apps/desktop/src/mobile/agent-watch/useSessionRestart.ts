import { useEffect, useRef, useState } from 'react'
import type { PendingPrompt } from '@gugu/session-chat-ui'
import { lifeIsStarting, type LifeView } from '@/session/shared/core/sessions/session-life'
import { canStartFreshSession } from '@/session/shared/core/sessions/session-recovery'
import { sessionInputBubbles } from '@/lib/sessionInputOutbox'
import { messageForUser } from '@/lib/userFacingError'
import { machineRpc } from './sessionpage-rpc'

/** Restart is the desktop's existing host action; only its lifecycle, never a local timer, says Starting. */
export function useSessionRestart({ deviceId, projectId, sessionId, missing, online, local, onReady }: {
  deviceId: string; projectId: string; sessionId: string; missing: boolean; online: boolean; local: boolean
  onReady(): void | Promise<void>
}) {
  const key = `${deviceId}:${sessionId}:${local}`
  const current = useRef(key)
  current.current = key
  const ready = useRef(onReady)
  ready.current = onReady
  const inFlight = useRef<string | null>(null)
  const baseline = useRef<{ key: string; version: number } | null>(null)
  const [eligible, setEligible] = useState<string | null>(null)
  const [attempt, setAttempt] = useState<{ key: string; afterVersion: number } | null>(null)
  const [view, setView] = useState<{ key: string; value: LifeView } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)

  useEffect(() => {
    if (!missing || !online) { setEligible(null); return }
    let active = true
    const host = machineRpc(deviceId, local)
    void Promise.all([host.sessions.getUnarchivedSession(projectId, sessionId), host.sessions.lifeView(sessionId)]).then(([rows, life]) => {
      if (active) baseline.current = { key, version: life.version }
      const absent = rows[0]?.providerSessionState === 'missing' || life.kind === 'dormant'
      if (active) setEligible(absent && !lifeIsStarting(life) && life.kind !== 'ready'
        && canStartFreshSession('provider_session_missing', rows[0]?.firstUtterance) ? key : null)
    }, () => { if (active) setEligible(null) })
    return () => { active = false }
  }, [deviceId, projectId, sessionId, missing, online, local, key])

  useEffect(() => {
    if (attempt?.key !== key || !online) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const next = await machineRpc(deviceId, local).sessions.lifeView(sessionId)
        if (!active) return
        if (next.version > attempt.afterVersion) {
          setView({ key, value: next })
          setError(null)
          if (next.kind === 'ready') {
            try { await ready.current() } catch (cause) { if (active) setError({ key, message: messageForUser(cause) }) }
            if (active) setAttempt(null)
            return
          }
          if (next.kind === 'dormant' && next.hold !== null) { setAttempt(null); return }
        }
      } catch (cause) {
        if (!active) return
        setError({ key, message: messageForUser(cause) })
      }
      if (active) timer = setTimeout(() => { void poll() }, 500)
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [attempt, key, deviceId, sessionId, online, local])

  const start = async (fresh: boolean) => {
    if (inFlight.current === key || !online || (fresh && eligible !== key)) return
    inFlight.current = key
    const afterVersion = view?.key === key ? view.value.version : baseline.current?.key === key ? baseline.current.version : 0
    setAttempt({ key, afterVersion })
    setBusy(key); setError(null); setView(null)
    try {
      const host = machineRpc(deviceId, local)
      if (fresh) await host.sessions.restartSession(projectId, sessionId)
      else await host.sessions.lifeStart(sessionId)
    } catch (cause) {
      if (current.current === key) { setAttempt(null); setError({ key, message: messageForUser(cause) }) }
    } finally {
      if (inFlight.current === key) inFlight.current = null
      if (current.current === key) setBusy(null)
    }
  }
  const life = view?.key === key ? view.value : null
  const starting = life !== null && lifeIsStarting(life)
  const head = starting ? sessionInputBubbles([], life.pending.items, life.hold)[0] : null
  const row = head && life?.pending.items.find(item => item.messageId === head.id)
  const pendingPrompt: PendingPrompt | null = head?.state === 'sending'
    ? { id: head.id, text: head.text, starting: 'starting', held: true, ...(row?.sentAt !== undefined ? { sentAt: row.sentAt } : {}) }
    : null
  return {
    canStartFresh: missing && eligible === key && life?.kind !== 'failed' && life?.kind !== 'ready',
    busy: busy === key || (attempt?.key === key && life?.kind !== 'failed'),
    refreshing: attempt?.key === key && life?.kind === 'ready',
    pendingPrompt,
    error: error?.key === key ? error.message : life?.failure?.message ?? null,
    startFresh: () => start(true),
    retry: life?.kind === 'failed' ? () => start(false) : null,
  }
}
