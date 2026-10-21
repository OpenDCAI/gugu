import { performance } from 'node:perf_hooks'
import { stopRuntimeHostWithTimeout } from '@gugu/core'

export interface RuntimeStopHost {
  stop: () => Promise<void> | void
}

export interface RuntimeBeforeQuitEvent {
  preventDefault: () => void
}

export interface RuntimeQuitHandlerOptions {
  getHost: () => RuntimeStopHost | null
  setQuitting: (value: boolean) => void
  exit: (code: number) => void
  warn?: (message: string) => void
  reportPhase?: (event: ShutdownPhaseEvent) => void
  timeoutMs?: number
  stopOwnedResources?: () => Promise<void>
  flushDurableStorage: () => Promise<void> | void
}

export type ShutdownPhaseEvent = {
  phase: string
  state: 'started' | 'completed' | 'failed'
  elapsedMs: number
  error?: string
}

type ShutdownPhaseSettlement =
  | { status: 'fulfilled' }
  | { status: 'rejected'; reason: unknown }

function reportShutdownPhaseSafely(report: ((event: ShutdownPhaseEvent) => void) | undefined, event: ShutdownPhaseEvent): void {
  try { report?.(event) } catch { /* diagnostics do not own shutdown progress */ }
}

export async function runShutdownPhase(
  phase: string,
  action: () => Promise<void> | void,
  report?: (event: ShutdownPhaseEvent) => void,
  settle?: (result: ShutdownPhaseSettlement) => void,
  timeoutMs = Number.POSITIVE_INFINITY,
): Promise<void> {
  const startedAt = performance.now()
  reportShutdownPhaseSafely(report, { phase, state: 'started', elapsedMs: 0 })
  let timer: ReturnType<typeof setTimeout> | undefined
  let actionSettlement: Promise<ShutdownPhaseSettlement>
  try {
    actionSettlement = Promise.resolve(action()).then(
      (): ShutdownPhaseSettlement => ({ status: 'fulfilled' }),
      (reason): ShutdownPhaseSettlement => ({ status: 'rejected', reason }),
    )
  } catch (reason) {
    actionSettlement = Promise.resolve({ status: 'rejected', reason })
  }
  const timeoutSettlement = Number.isFinite(timeoutMs)
    ? new Promise<ShutdownPhaseSettlement>((resolve) => {
      timer = setTimeout(() => resolve({
        status: 'rejected',
        reason: new Error(`${phase} timed out after ${timeoutMs}ms`),
      }), Math.max(0, timeoutMs))
    })
    : new Promise<ShutdownPhaseSettlement>(() => undefined)
  const settlement = await Promise.race([actionSettlement, timeoutSettlement])
  if (timer) clearTimeout(timer)

  // The final report is synchronous and precedes settlement because the last settlement's
  // native terminal never returns. Reporter failures still cannot own shutdown progress.
  if (settlement.status === 'rejected') {
    reportShutdownPhaseSafely(report, {
      phase,
      state: 'failed',
      elapsedMs: Math.round(performance.now() - startedAt),
      error: String((settlement.reason as Error)?.message ?? settlement.reason),
    })
    settle?.(settlement)
    throw settlement.reason
  }
  reportShutdownPhaseSafely(report, { phase, state: 'completed', elapsedMs: Math.round(performance.now() - startedAt) })
  settle?.(settlement)
}

const DEFAULT_RUNTIME_STOP_TIMEOUT_MS = 5_000

export function createRuntimeBeforeQuitHandler(options: RuntimeQuitHandlerOptions) {
  let stopInProgress = false

  return (event: RuntimeBeforeQuitEvent): void => {
    options.setQuitting(true)

    const host = options.getHost()
    event.preventDefault()
    if (stopInProgress) return
    stopInProgress = true

    let remainingPhases = 1 + Number(Boolean(host)) + Number(Boolean(options.stopOwnedResources))
    let failureCount = 0
    const settlePhase = (result: ShutdownPhaseSettlement): void => {
      if (result.status === 'rejected') {
        failureCount += 1
        options.warn?.(`[device-runtime] stop before quit failed: ${String((result.reason as Error)?.message ?? result.reason)}`)
      }
      remainingPhases -= 1
      if (remainingPhases === 0) {
        // Run the terminal in the final phase's continuation. Deferring it through another
        // aggregate-promise reaction lets unrelated shutdown-time work block the dying host.
        options.exit(failureCount === 0 ? 0 : 1)
      }
    }
    if (host) {
      void runShutdownPhase(
        'device-runtime-host',
        () => stopRuntimeHostWithTimeout(host, options.timeoutMs ?? DEFAULT_RUNTIME_STOP_TIMEOUT_MS),
        options.reportPhase,
        settlePhase,
        options.timeoutMs ?? DEFAULT_RUNTIME_STOP_TIMEOUT_MS,
      ).catch(() => undefined)
    }
    if (options.stopOwnedResources) {
      void runShutdownPhase(
        'owned-resources',
        options.stopOwnedResources,
        options.reportPhase,
        settlePhase,
        options.timeoutMs ?? DEFAULT_RUNTIME_STOP_TIMEOUT_MS,
      ).catch(() => undefined)
    }
    void runShutdownPhase(
      'chromium-storage',
      options.flushDurableStorage,
      options.reportPhase,
      settlePhase,
      options.timeoutMs ?? DEFAULT_RUNTIME_STOP_TIMEOUT_MS,
    ).catch(() => undefined)
  }
}
