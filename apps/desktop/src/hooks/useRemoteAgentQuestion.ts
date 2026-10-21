import { useCallback, useEffect, useState } from 'react'
import type { QuestionAnswer, Settlement } from '@gugu/session-core/session-record/contract'
import type { SessionDirectoryRow } from '../session/shared/remote-sessions/session-directory'
import { useDevicesStore } from '../store/devicesContext'
import { latestAgentQuestion } from '../lib/agentQuestion'
import {
  fetchSnapshot, onLinkChange, respondToSettlement, subscribeSession, subscribeSessionEvents, unsubscribeSession,
} from '../mobile/agent-watch/sessionpage-rpc'

/** Uses the existing host timeline, including its one-winner answer path; never creates a second question. */
export function useRemoteAgentQuestion(row: SessionDirectoryRow | null, localSessionId: string | null) {
  const { devices } = useDevicesStore()
  const deviceId = row && !localSessionId && !devices.find((device) => device.device_id === row.deviceId)?.is_current_device ? row.deviceId : null
  const sessionId = deviceId ? row?.session.conversationId ?? null : null
  const key = `${deviceId ?? ''}:${sessionId ?? ''}`
  const [attempt, retry] = useState(0)
  const [state, setState] = useState<{ key: string; settlements: Record<string, Settlement>; available: boolean }>({ key: '', settlements: {}, available: false })
  useEffect(() => {
    if (!deviceId || !sessionId) return
    let alive = true
    let disconnected = false
    const subscriptionId = crypto.randomUUID()
    const offEvents = subscribeSessionEvents(deviceId, subscriptionId, (result) => {
      if (!alive) return
      const incoming = result.ok ? result.batch.settlements : result.snapshot.settlements
      setState((previous) => ({ key, available: true, settlements: Object.fromEntries([
        ...Object.entries(result.ok && previous.key === key ? previous.settlements : {}), ...incoming.map((item) => [item.itemId, item] as const),
      ]) }))
    })
    const offLink = onLinkChange(deviceId, (open) => {
      if (!alive) return
      if (!open) { disconnected = true; setState((previous) => previous.key === key ? { ...previous, available: false } : previous) }
      else if (disconnected) { disconnected = false; retry((n) => n + 1) }
    })
    void (async () => {
      try {
        const snapshot = await fetchSnapshot(deviceId, sessionId, 30)
        if (!alive) return
        setState({ key, settlements: Object.fromEntries(snapshot.settlements.map((item) => [item.itemId, item])), available: true })
        await subscribeSession(deviceId, sessionId, subscriptionId, snapshot.cursor)
        if (!alive) await unsubscribeSession(deviceId, subscriptionId)
      } catch {
        if (alive) setState((previous) => ({ key, settlements: previous.key === key ? previous.settlements : {}, available: false }))
      }
    })()
    return () => { alive = false; offEvents(); offLink(); void unsubscribeSession(deviceId, subscriptionId).catch(() => undefined) }
  }, [deviceId, sessionId, key, attempt])
  const respond = useCallback((answers: readonly QuestionAnswer[], itemId: string) => {
    if (!deviceId || !sessionId) throw new Error('Question device is unavailable')
    return respondToSettlement(deviceId, { conversationId: sessionId, itemId, kind: 'question', answers, by: 'desktop' })
  }, [deviceId, sessionId])
  return { key, question: state.key === key ? latestAgentQuestion(state.settlements) : null, available: state.key === key && state.available, respond }
}
