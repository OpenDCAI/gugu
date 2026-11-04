import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { SessionInput } from '@/lib/sessionInputOutbox'
import { canReleasePhoneInput } from './phone-input-queue'

export type PhoneQueueSource = { read(): Promise<{ ready: boolean; turns: readonly TranscriptTurn[] }>; dispose(): void }
export type PhoneQueueObserverDependencies = {
  current(): boolean
  inputs(): readonly SessionInput[]
  subscribe(listener: () => void): () => void
  retainDirectory(): () => void
  available(input: SessionInput): boolean
  observe(input: SessionInput, changed: () => void): PhoneQueueSource
  release(sessionId: string, turns: readonly TranscriptTurn[]): Promise<unknown>
  report(error: unknown): void
}

/** Lives with the signed-in shell, so returning from a task does not strand its persistent queue. */
export function startPhoneSendQueueObserver(accountId: string, deps: PhoneQueueObserverDependencies): () => void {
  type Watch = { closed: boolean; checking: boolean; again: boolean; source: PhoneQueueSource | null; check(): Promise<void> }
  const watches = new Map<string, Watch>()
  let closed = false
  let releaseDirectory: (() => void) | null = null
  const valid = () => !closed && deps.current()
  const stop = (key: string, watch: Watch) => { watch.closed = true; watch.source?.dispose(); watches.delete(key) }
  const refresh = () => {
    if (!valid()) {
      for (const [key, watch] of watches) stop(key, watch)
      releaseDirectory?.(); releaseDirectory = null
      return
    }
    const inputs = deps.inputs().filter(input => input.accountId === accountId && input.sendQueue)
    if (inputs.length && !releaseDirectory) releaseDirectory = deps.retainDirectory()
    if (!inputs.length) { releaseDirectory?.(); releaseDirectory = null }
    const targets = new Map(inputs.filter(deps.available).map(input => [`${input.deviceId}/${input.sessionId}`, input]))
    for (const [key, watch] of watches) if (!targets.has(key)) stop(key, watch)
    for (const [key, input] of targets) {
      const existing = watches.get(key)
      if (existing) { void existing.check(); continue }
      const watch: Watch = {
        closed: false, checking: false, again: false, source: null,
        async check() {
          if (watch.checking) { watch.again = true; return }
          watch.checking = true
          try {
            do {
              watch.again = false
              if (!valid() || watch.closed || !deps.available(input) || !watch.source) return
              const snapshot = await watch.source.read()
              if (!valid() || watch.closed || !deps.available(input)) return
              if (watch.again) continue
              if (canReleasePhoneInput(snapshot.ready, false, false, snapshot.turns)) await deps.release(input.sessionId, snapshot.turns)
            } while (watch.again && valid() && !watch.closed)
          } catch (error) { if (valid() && !watch.closed) deps.report(error) }
          finally { watch.checking = false }
        },
      }
      try {
        watch.source = deps.observe(input, () => { void watch.check() })
        watches.set(key, watch)
        void watch.check()
      } catch (error) { deps.report(error) }
    }
  }
  const unsubscribe = deps.subscribe(refresh)
  refresh()
  return () => {
    closed = true; unsubscribe()
    for (const [key, watch] of watches) stop(key, watch)
    releaseDirectory?.(); releaseDirectory = null
  }
}
