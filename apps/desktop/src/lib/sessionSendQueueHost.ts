import { ReplicaState } from '@gugu/session-wire'
import { sessionStateSchema, type SessionState } from '@gugu/session-core/acp/client'
import { getAcpRuntimeClient } from '@/session/renderer/lib/acp/runtime-client'
import { releaseQueuedSessionInput, state, subscribeSessionInputs } from './sessionInputOutboxBridge'
import { rendererLogger } from './log'
import { onMachineEvent, rpcOn } from '@/session/renderer/lib/ipc'
import { sessionLifeViewChannel } from '@/session/shared/core/sessions/sessionEvents'

function foregroundQueueReady(snapshot: SessionState): boolean {
  const completed = snapshot.lastTurnOutcome === 'none'
    || (snapshot.lastTurnOutcome === 'stopped' && snapshot.lastStopReason === 'end_turn')
  return snapshot.lifecycle === 'ready' && snapshot.activeTurnId === null && !snapshot.queuedPrompts.length && completed
}

/** Observe only sessions with composer-owned inputs; no engine is started by this observer. */
export function watchSessionSendQueues(accountId: string, currentDeviceId: () => string | undefined): () => void {
  type Watch = { closed: boolean; replica?: ReplicaState<SessionState>; checking: boolean; again: boolean; check?: () => Promise<void>; stopLife?: () => void }
  const watches = new Map<string, Watch>()
  let closed = false
  const report = (error: unknown) => rendererLogger('session/send-queue').warn({ error: String(error) }, 'Could not release composer queue')
  const refresh = () => {
    const own = state()
    if (closed || !own.valid() || own.accountId !== accountId) return
    const targets = new Map(own.rows.filter(input => input.accountId === accountId && input.sendQueue)
      .map(input => [`${input.deviceId ?? 'local'}/${input.sessionId}`, input]))
    for (const [key, watch] of watches) if (!targets.has(key)) {
      watch.closed = true; watch.stopLife?.(); void watch.replica?.dispose(); watches.delete(key)
    }
    for (const [key, input] of targets) {
      if (watches.has(key)) { void watches.get(key)!.check?.(); continue }
      const watch: Watch = { closed: false, checking: false, again: false }
      watches.set(key, watch)
      const machine = !input.deviceId || input.deviceId === currentDeviceId() ? null : input.deviceId
      void getAcpRuntimeClient(machine).then(async client => {
        if (closed || watch.closed) return
        const check = async () => {
          if (watch.checking) { watch.again = true; return }
          watch.checking = true
          try {
            do {
              watch.again = false
              if (closed || watch.closed || !own.valid() || own.accountId !== accountId) return
              const snapshot = watch.replica!.current()
              // A background child does not hold the composer's foreground queue. A retained native turn does.
              if (!foregroundQueueReady(snapshot)) return
              const life = await rpcOn(machine).sessions.lifeView(input.sessionId)
              if (life.kind !== 'ready' || life.hold !== null) return
              const history = await client.getHistory({ sessionId: input.sessionId, limit: 100 })
              if (!history.success) throw new Error('Session history is not available')
              if (closed || watch.closed || !own.valid() || own.accountId !== accountId) return
              if (watch.again) continue
              const latest = watch.replica!.current()
              if (!foregroundQueueReady(latest)) return
              await releaseQueuedSessionInput(input.sessionId, history.data.turns, undefined, false, () => {
                const current = watch.replica!.current()
                return !closed && !watch.closed && !watch.again && own.valid() && own.accountId === accountId
                  && foregroundQueueReady(current)
              })
            } while (watch.again)
          } catch (error) { report(error) }
          finally { watch.checking = false }
        }
        const replica = new ReplicaState(client.session.state({ sessionId: input.sessionId }, 'state'), { schema: sessionStateSchema })
        watch.replica = replica
        replica.onGone(error => {
          report(error); watch.closed = true; watch.stopLife?.(); void replica.dispose()
          if (watches.get(key) === watch) watches.delete(key)
        })
        await replica.ready
        if (closed || watch.closed) { void replica.dispose(); return }
        watch.check = check
        watch.stopLife = onMachineEvent(machine, sessionLifeViewChannel, view => { if (view.sessionId === input.sessionId) void check() })
        replica.onChange(() => { void check() })
        await check()
      }).catch(error => {
        report(error); watch.closed = true; watch.stopLife?.(); void watch.replica?.dispose()
        if (watches.get(key) === watch) watches.delete(key)
      })
    }
  }
  const unsubscribe = subscribeSessionInputs(refresh)
  refresh()
  return () => {
    closed = true; unsubscribe()
    for (const watch of watches.values()) { watch.closed = true; watch.stopLife?.(); void watch.replica?.dispose() }
    watches.clear()
  }
}
