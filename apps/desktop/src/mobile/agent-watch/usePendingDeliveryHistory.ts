import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { pendingPromptLanded, type PendingPrompt } from '@session-chat/state/pending-prompt'
import { loadPendingDeliveryHistory } from '@/lib/pendingSessionDeliveries'
import { messageForUser } from '@/lib/userFacingError'
import { machineRpc } from './sessionpage-rpc'
import { mergePendingDeliveryHistoryTurns } from './pending-delivery-history-turns'

/** Only unknown receipts resolve older native pages; normal first paint and its requests stay unchanged. */
export function usePendingDeliveryHistory({ deviceId, sessionId, local, enabled, ready, cursor, turns, inputs }: {
  deviceId: string; sessionId: string; local: boolean; enabled: boolean; ready: boolean; cursor?: number | null
  turns: readonly TranscriptTurn[]; inputs: readonly PendingPrompt[]
}) {
  const key = `${local ? 'local' : deviceId}/${sessionId}`
  const [read, setRead] = useState<{ key: string; extra: readonly TranscriptTurn[]; resolved: readonly string[]; error: string | null }>({ key, extra: [], resolved: [], error: null })
  const own: Pick<typeof read, 'extra' | 'resolved' | 'error'> = read.key === key ? read : { extra: [], resolved: [], error: null }
  const merged = useMemo(() => mergePendingDeliveryHistoryTurns(turns, own.extra), [turns, own.extra])
  const unknownKey = inputs.filter(input => input.delivery?.state === 'unknown' && !own.resolved.includes(input.id)
    && !pendingPromptLanded(input, merged)).map(input => input.id).sort().join('\0')
  const current = useRef({ inputs, turns: merged, cursor })
  current.current = { inputs, turns: merged, cursor }
  useEffect(() => {
    if (!ready || !unknownKey) return
    let alive = true
    const ids = unknownKey.split('\0')
    const snapshot = current.current
    const finish = (extra: readonly TranscriptTurn[], error: string | null) => {
      if (!alive) return
      setRead(previous => {
        const prior = previous.key === key ? previous : { extra: [], resolved: [] }
        const byId = new Map([...prior.extra, ...extra].map(turn => [turn.id, turn]))
        return { key, extra: [...byId.values()].sort((a, b) => a.seq - b.seq), resolved: [...new Set([...prior.resolved, ...ids])], error }
      })
    }
    void loadPendingDeliveryHistory(snapshot.turns, enabled ? snapshot.cursor ?? null : null,
      snapshot.inputs.filter(input => ids.includes(input.id)),
      before => machineRpc(deviceId, local).sessions.getStoredHistory({ sessionId, before, limit: 100 }), () => alive)
      .then(result => finish(result.turns, null), (error: unknown) => finish([], messageForUser(error)))
    return () => { alive = false }
  }, [key, deviceId, sessionId, local, enabled, ready, unknownKey])
  const visible = useCallback((input: PendingPrompt) => input.delivery?.state !== 'unknown'
    || (ready && (own.resolved.includes(input.id) || pendingPromptLanded(input, merged))), [ready, own.resolved, merged])
  return { turns: merged, error: own.error, visible }
}
