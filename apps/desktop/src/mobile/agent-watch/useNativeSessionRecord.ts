import { useCallback, useEffect, useRef, useState } from 'react'
import { isDeepEqual } from '@gugu/session-shared'
import { remoteFailureKind, type NativeSessionRecord } from '@gugu/session-core/session-record/contract'
import { machineRpc } from './sessionpage-rpc'
import { messageForUser } from '@/lib/userFacingError'
import { hydrateCachedNativeRecord, readCachedNativeRecord, writeCachedNativeRecord } from './timeline-cache'

/** ACP records come from the task page archive, not a second parse of the provider's JSONL. */
export function useNativeSessionRecord(deviceId: string, sessionId: string, enabled: boolean, online: boolean) {
  // What this phone read last time is drawn first, and is all there is while that machine is away.
  const [record, setRecord] = useState<NativeSessionRecord | null>(() => readCachedNativeRecord({ deviceId, sessionId }))
  const [error, setError] = useState<string | null>(null)
  /** The last read failed because that machine did not answer (not because it refused): the page says it is away. */
  const [unreachable, setUnreachable] = useState(false)
  const epoch = useRef(0)
  const current = useRef({ deviceId, sessionId, enabled })
  current.current = { deviceId, sessionId, enabled }
  const value = useRef(record)
  value.current = record
  const requests = useRef<Promise<void>>(Promise.resolve())
  const tailRequested = useRef(false)
  useEffect(() => {
    const generation = ++epoch.current
    requests.current = Promise.resolve(); tailRequested.current = false
    const cached = readCachedNativeRecord({ deviceId, sessionId })
    value.current = cached; setRecord(cached); setError(null)
    if (!cached) void hydrateCachedNativeRecord({ deviceId, sessionId }).then((stored) => {
      if (!stored || epoch.current !== generation || value.current) return
      value.current = stored; setRecord(stored)
    })
    return () => { epoch.current = generation + 1 }
  }, [deviceId, sessionId, enabled])
  const read = useCallback((mode: 'poll' | 'older' | 'newer' | 'tail' = 'poll') => {
    const ownEpoch = epoch.current
    const nextRequest = requests.current.catch(() => undefined).then(async () => {
      if (epoch.current !== ownEpoch) return
      const requested = current.current
      const previous = value.current
      const last = previous?.turns.at(-1)?.seq
      const tail = mode === 'tail' || tailRequested.current
      const input = mode === 'older' ? { before: previous?.nextCursor ?? undefined }
        : tail ? { tail: true } : mode === 'newer' && last !== undefined ? { after: last }
        : previous?.hasNewer && last !== undefined ? { before: last + 1 }
        : last !== undefined ? { after: Math.max(-1, last - 29) } : {}
      const result = await machineRpc(deviceId).sessionTimeline.sessionNativeRecord({ conversationId: sessionId, ...input })
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
      if (epoch.current !== ownEpoch || current.current.deviceId !== requested.deviceId || current.current.sessionId !== requested.sessionId || !current.current.enabled) return
      const page = result.value
      if (tail) tailRequested.current = false
      const merge = (previous: NativeSessionRecord | null): NativeSessionRecord => {
        if (!previous || tail) return page
        const merged = new Map(previous.turns.filter(turn => turn.seq <= page.latestStoredSeq).map(turn => [turn.id, turn]))
        for (const turn of page.turns) merged.set(turn.id, turn)
        const next = { ...page, turns: [...merged.values()].sort((a, b) => a.seq - b.seq),
          hasNewer: mode === 'older' ? previous.hasNewer : page.hasNewer,
          activeTurn: mode === 'older' ? previous.activeTurn : page.activeTurn,
          nextCursor: mode === 'older' || !previous.turns.length ? page.nextCursor : previous.nextCursor }
        const origins = new Map(previous.turns.map((turn, index) => [turn.id, previous.originTurnIds[index] ?? turn.id]))
        page.turns.forEach((turn, index) => origins.set(turn.id, page.originTurnIds[index] ?? turn.id))
        next.originTurnIds = next.turns.map(turn => origins.get(turn.id)!)
        return isDeepEqual(previous, next) ? previous : next
      }
      const next = merge(value.current)
      if (next !== value.current) writeCachedNativeRecord({ deviceId, sessionId }, next)
      value.current = next; setRecord(next)
      setError(null); setUnreachable(false)
    })
    requests.current = nextRequest
    return nextRequest
  }, [deviceId, sessionId])
  useEffect(() => {
    if (!enabled || !online) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try { if (document.visibilityState !== 'hidden') await read() } catch (error) {
        if (!active) return
        setError(messageForUser(error))
        const code = (error as { code?: unknown } | null)?.code
        setUnreachable(remoteFailureKind(typeof code === 'string' ? code : null) === 'machine-unreachable')
      }
      if (active) timer = setTimeout(() => { void poll() }, 1000)
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [enabled, online, read])
  const report = (error: unknown) => setError(messageForUser(error))
  return { record, error, unreachable,
    loadOlder: async () => { if (value.current?.nextCursor !== null && value.current?.nextCursor !== undefined) await read('older') },
    loadNewer: () => { if (value.current?.hasNewer) void read('newer').catch(report) },
    followTail: () => { tailRequested.current = true; if (online) void read('tail').catch(report) },
  }
}
