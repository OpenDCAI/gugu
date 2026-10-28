import type { PrepareLocalHomeInput, PrepareLocalHomeResult, LocalAssistantPreparationState } from '../src/lib/assistantHomeIpc'
import type { PreparedAssistantRuntime } from './assistant-runtime-prepare'

/** Main-process ownership makes cancellation and the first active write mutually exclusive. */
export function createAssistantSetupPreparation(deps: {
  prepare(id: string, signal: AbortSignal): Promise<PreparedAssistantRuntime>
  cleanup?(id: string): Promise<void>
  install(input: PrepareLocalHomeInput): Promise<PrepareLocalHomeResult>
  changed(id: string, state: LocalAssistantPreparationState): void
}) {
  type Attempt = { state: LocalAssistantPreparationState; abort: AbortController; prepared?: PreparedAssistantRuntime; work: Promise<void>; installationStarted?: boolean; installation?: Promise<PrepareLocalHomeResult>; cleanupFailed?: boolean }
  const attempts = new Map<string, Attempt>()
  const requireAttempt = (id: string) => {
    const attempt = attempts.get(id)
    if (!attempt) throw new Error('This assistant preparation no longer exists')
    return attempt
  }
  function set(id: string, attempt: Attempt, state: LocalAssistantPreparationState) {
    attempt.state = state
    deps.changed(id, state)
  }
  const service = {
    start(id: string) {
      if (attempts.has(id)) throw new Error('This assistant preparation already exists')
      const attempt: Attempt = { state: { phase: 'preparing' }, abort: new AbortController(), work: Promise.resolve() }
      attempts.set(id, attempt)
      attempt.work = deps.prepare(id, attempt.abort.signal).then(prepared => {
        attempt.prepared = prepared
        if (!attempt.abort.signal.aborted) set(id, attempt, { phase: 'ready' })
      }).catch(error => {
        attempt.cleanupFailed = (error as { code?: string } | null)?.code === 'assistant_preparation_cleanup_failed'
        set(id, attempt, { phase: 'failed', error: error instanceof Error ? error.message : String(error) })
      })
      return attempt.state
    },
    status(id: string) { return requireAttempt(id).state },
    async cancel(id: string): Promise<boolean> {
      const attempt = requireAttempt(id)
      if (attempt.installationStarted) return false
      attempt.abort.abort(new Error('Assistant preparation cancelled'))
      await attempt.work
      if (attempt.cleanupFailed) {
        if (!deps.cleanup) throw new Error('Assistant preparation cleanup failed; setup was not cancelled')
        await deps.cleanup(id)
        attempt.cleanupFailed = false
      }
      await attempt.prepared?.dispose()
      set(id, attempt, { phase: 'cancelled' })
      return true
    },
    async commit(id: string, input: PrepareLocalHomeInput) {
      const attempt = requireAttempt(id)
      if (attempt.abort.signal.aborted || attempt.state.phase !== 'ready') throw new Error('Assistant preparation is not ready to install')
      // No await between this check and the state change: cancel can no longer
      // succeed before any active launcher or assistant-home write is performed.
      attempt.installationStarted = true
      set(id, attempt, { phase: 'committing' })
      attempt.installation = (async () => {
        try {
          await attempt.prepared!.commit()
          const home = await deps.install(input)
          await attempt.prepared!.dispose()
          set(id, attempt, { phase: 'committed' })
          return home
        } catch (error) {
          try { await attempt.prepared!.dispose() }
          finally { set(id, attempt, { phase: 'failed', installationStarted: true, error: error instanceof Error ? error.message : String(error) }) }
          throw error
        }
      })()
      return attempt.installation
    },
    async release(id: string) {
      const attempt = attempts.get(id)
      if (!attempt) return
      if (!attempt.installationStarted) await service.cancel(id)
      else await attempt.installation?.catch(() => undefined)
      attempts.delete(id)
    },
  }
  return service
}
