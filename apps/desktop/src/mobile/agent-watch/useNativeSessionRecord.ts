import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isDeepEqual } from '@gugu/session-shared'
import { remoteFailureKind, type NativeSessionRecord } from '@gugu/session-core/session-record/contract'
import { machineRpc, onLinkChange } from './sessionpage-rpc'
import { messageForUser } from '@/lib/userFacingError'
import { hydrateCachedNativeRecord, readCachedNativeRecord, writeCachedNativeRecord } from './timeline-cache'
import { recoverTimelineRead } from './timeline-read-recovery'
import { mergeNativeRecordPage, projectNativeRecord } from './native-record-state'

/** ACP records come from the task page archive, not a second parse of the provider's JSONL. */
export function useNativeSessionRecord(deviceId: string, sessionId: string, enabled: boolean, online: boolean, local = false) {
  // What this phone read last time is drawn first, and is all there is while that machine is away.
  const [record, setRecord] = useState<NativeSessionRecord | null>(() => readCachedNativeRecord({ deviceId, sessionId }))
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  /** The last read failed because that machine did not answer (not because it refused): the page says it is away. */
  const [unreachable, setUnreachable] = useState(false)
  const epoch = useRef(0)
  const recoveryAbort = useRef(new AbortController())
  const key = `${deviceId}/${sessionId}`
  const [confirmed, setConfirmed] = useState<{ key: string; epoch: number } | null>(null)
  const connected = useRef(online)
  const current = useRef({ deviceId, sessionId, enabled, online })
  current.current = { deviceId, sessionId, enabled, online }
  const value = useRef(record)
  value.current = record
  const requests = useRef<Promise<void>>(Promise.resolve())
  const tailRequested = useRef(true)
  useEffect(() => {
    const connectionEpoch = epoch
    const generation = ++connectionEpoch.current
    recoveryAbort.current.abort(); recoveryAbort.current = new AbortController()
    connected.current = online; setConfirmed(null)
    // Reconcile the latest page first, even when the cache or host's first unread is far behind.
    requests.current = Promise.resolve(); tailRequested.current = true
    const cached = readCachedNativeRecord({ deviceId, sessionId })
    value.current = cached; setRecord(cached); setError(null); setErrorCode(null)
    if (!cached) void hydrateCachedNativeRecord({ deviceId, sessionId }).then((stored) => {
      if (!stored || epoch.current !== generation || value.current) return
      value.current = stored; setRecord(stored)
    })
    return () => { connectionEpoch.current++; recoveryAbort.current.abort() }
  }, [deviceId, sessionId, enabled, online])
  const read = useCallback((mode: 'poll' | 'older' | 'newer' | 'tail' = 'poll') => {
    const ownEpoch = epoch.current
    const signal = recoveryAbort.current.signal
    const nextRequest = requests.current.catch(() => undefined).then(async () => {
      if (epoch.current !== ownEpoch || !connected.current || !current.current.enabled || !current.current.online) return
      const requested = current.current
      const previous = value.current
      const last = previous?.turns.at(-1)?.seq
      const tail = mode !== 'older' && (mode === 'tail' || tailRequested.current)
      const input = mode === 'older' ? { before: previous?.nextCursor ?? undefined }
        : tail ? { tail: true } : (mode === 'newer' || previous?.hasNewer) && last !== undefined ? { after: last }
        : last !== undefined ? { after: Math.max(-1, last - 29) } : {}
      const page = await recoverTimelineRead(async () => {
        const result = await machineRpc(deviceId, local).sessionTimeline.sessionNativeRecord({ conversationId: sessionId, ...input })
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
        return result.value
      }, signal, () => { if (epoch.current === ownEpoch) setConfirmed(null) })
      if (epoch.current !== ownEpoch || current.current.deviceId !== requested.deviceId || current.current.sessionId !== requested.sessionId || !current.current.enabled) return
      if (tail) tailRequested.current = false
      const merged = mergeNativeRecordPage(value.current, page, mode, tail)
      const next = isDeepEqual(value.current, merged) ? value.current! : merged
      if (next !== value.current) writeCachedNativeRecord({ deviceId, sessionId }, next)
      value.current = next; setRecord(next)
      if (mode !== 'older') setConfirmed(previous => previous?.key === key && previous.epoch === ownEpoch ? previous : { key, epoch: ownEpoch })
      setError(null); setErrorCode(null); setUnreachable(false)
    })
    requests.current = nextRequest
    return nextRequest.catch(error => {
      if (epoch.current !== ownEpoch) return
      setConfirmed(null); throw error
    })
  }, [deviceId, sessionId, local, key])
  useEffect(() => {
    if (!enabled || !online || local) return
    return onLinkChange(deviceId, open => {
      recoveryAbort.current.abort(); recoveryAbort.current = new AbortController()
      epoch.current++; connected.current = open; requests.current = Promise.resolve(); tailRequested.current = true; setConfirmed(null)
      if (open) { const ownEpoch = epoch.current; void read('tail').catch(error => { if (epoch.current === ownEpoch) setError(messageForUser(error)) }) }
    })
  }, [deviceId, enabled, online, local, read])
  useEffect(() => {
    if (!enabled || !online) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try { if (document.visibilityState !== 'hidden') await read() } catch (error) {
        if (!active) return
        setError(messageForUser(error))
        const code = (error as { code?: unknown } | null)?.code
        setErrorCode(typeof code === 'string' ? code : null)
        setUnreachable(remoteFailureKind(typeof code === 'string' ? code : null) === 'machine-unreachable')
      }
      if (active) timer = setTimeout(() => { void poll() }, 1000)
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [enabled, online, read])
  const report = (error: unknown) => setError(messageForUser(error))
  const shown = useMemo(() => projectNativeRecord(record), [record])
  return { record: shown, error, errorCode, unreachable, ready: enabled && online && confirmed?.key === key && confirmed.epoch === epoch.current,
    reload: () => read('tail'),
    loadOlder: async () => { if (value.current?.nextCursor !== null && value.current?.nextCursor !== undefined) await read('older') },
    loadNewer: () => { if (value.current?.hasNewer) void read('newer').catch(report) },
    followTail: () => { tailRequested.current = true; if (online) void read('tail').catch(report) },
  }
}
