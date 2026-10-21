import type { SessionCredentialLifecycle, SessionpageSessionSurface } from '@gugu/session-core/agents/plugins'

export type SessionpagePlatformRecoveryStatus = 'live' | 'expired' | 'reopening' | 'failed'

export type SessionpagePlatformRecoveryState = {
  status: SessionpagePlatformRecoveryStatus
  error?: string
  observation?: PlatformCredentialRuntimeObservation
  credentialGeneration?: string
}

export type PlatformCredentialObservationSource =
  | 'lease'
  | 'real-request'
  | 'gateway'
  | 'provider'
  | 'recovery'

export type PlatformCredentialRuntimeObservation = {
  generation: string
  source: PlatformCredentialObservationSource
  observedAt: string
  leaseExpiresAt: string | null
  operation: 'issue' | 'renew' | 'request' | 'expiry' | 'reopen' | 'release'
  outcome: 'success' | 'failure' | 'observed'
  classification: string
}

export type SessionpagePlatformRecoveryTarget = {
  sessionId: string
  projectId: string
  providerId: string
  surface: SessionpageSessionSurface
  expiresAt?: string
  credentialGeneration?: string
}

export type SessionpageSessionReadyResult =
  | { status: 'ready' }
  | { status: 'failed'; error: string }

export interface SessionpagePlatformRecoveryDeps {
  isExpired(sessionId: string): boolean
  resolveTarget(sessionId: string): SessionpagePlatformRecoveryTarget | null | Promise<SessionpagePlatformRecoveryTarget | null>
  reopen(target: SessionpagePlatformRecoveryTarget): Promise<void>
  refresh?(target: SessionpagePlatformRecoveryTarget): Promise<void>
  /** Wait for the provider's own post-reopen admission signal before publishing live. */
  waitUntilReady?(target: SessionpagePlatformRecoveryTarget): Promise<void>
  /** Keep an already-running provider turn on its existing owner until its terminal event. */
  isTurnInFlight?(target: SessionpagePlatformRecoveryTarget): boolean | Promise<boolean>
  /** Resolve the static descriptor capability; the coordinator never imports the plugin registry. */
  credentialLifecycleFor?(target: SessionpagePlatformRecoveryTarget): SessionCredentialLifecycle | null
  onStateChange?(target: SessionpagePlatformRecoveryTarget, state: SessionpagePlatformRecoveryState): void
  currentGeneration?(sessionId: string): string | null
}

/**
 * Host-owned wall-clock credential recovery state machine.
 *
 * This class deliberately does not know how a message is stored or delivered. Callers ask for a
 * ready conversation first, then pass the original message to their existing owner. A failed gate
 * therefore cannot advance an inbox cursor, acknowledge a session-direct row, or mark a composer
 * send as delivered.
 */
export class SessionpagePlatformRecoveryCoordinator {
  private readonly states = new Map<string, SessionpagePlatformRecoveryState>()
  private readonly targets = new Map<string, SessionpagePlatformRecoveryTarget>()
  private readonly flights = new Map<string, Promise<SessionpageSessionReadyResult>>()
  private readonly runs = new Map<string, symbol>()
  private readonly pendingObservations = new Map<string, PlatformCredentialRuntimeObservation>()

  constructor(private readonly deps: SessionpagePlatformRecoveryDeps) {}

  stateFor(sessionId: string): SessionpagePlatformRecoveryState | null {
    return this.states.get(sessionId) ?? null
  }

  markExpired(target: SessionpagePlatformRecoveryTarget): void {
    if (target.credentialGeneration && this.deps.currentGeneration
      && this.deps.currentGeneration(target.sessionId) !== target.credentialGeneration) return
    this.targets.set(target.sessionId, target)
    this.pendingObservations.delete(target.sessionId)
    const current = this.states.get(target.sessionId)
    if (current?.status === 'expired' || current?.status === 'reopening' || current?.status === 'failed') return
    const observation = target.credentialGeneration ? {
      generation: target.credentialGeneration,
      source: 'lease' as const,
      observedAt: new Date().toISOString(),
      leaseExpiresAt: target.expiresAt ?? null,
      operation: 'expiry' as const,
      outcome: 'observed' as const,
      classification: 'wall-clock-expired',
    } satisfies PlatformCredentialRuntimeObservation : null
    this.publish(target, observation ? { status: 'expired', observation } : { status: 'expired' })
  }

  /** Record a provider-neutral observation, dropping late results from an older lease generation. */
  recordObservation(
    sessionId: string,
    observation: PlatformCredentialRuntimeObservation,
  ): boolean {
    if (this.deps.currentGeneration && this.deps.currentGeneration(sessionId) !== observation.generation) return false
    const target = this.targets.get(sessionId)
    const latest = target ? this.states.get(sessionId)?.observation : this.pendingObservations.get(sessionId)
    if (latest?.generation === observation.generation && Date.parse(latest.observedAt) > Date.parse(observation.observedAt)) return false
    if (!target) {
      // Issue/renew can be emitted before the host has registered the delivery target. Keep only
      // the newest event; the target's generation check below will reject a late lease safely.
      this.pendingObservations.set(sessionId, observation)
      return true
    }
    const currentGeneration = this.deps.currentGeneration?.(sessionId) ?? target.credentialGeneration
    if (currentGeneration && observation.generation !== currentGeneration) return false
    const current = this.states.get(sessionId) ?? { status: 'live' as const }
    this.publish(target, { ...current, observation })
    return true
  }

  async reconcileExpired(): Promise<void> {
    const targetIds = [...this.targets.keys()]
    await Promise.all(targetIds.map(async (sessionId) => {
      const target = await this.deps.resolveTarget(sessionId)
      if (target && this.deps.isExpired(sessionId)) this.markExpired(target)
    }))
  }

  async ensureReady(sessionId: string, _trigger = 'use'): Promise<SessionpageSessionReadyResult> {
    const target = await this.deps.resolveTarget(sessionId) ?? this.targets.get(sessionId) ?? null
    if (!target) return { status: 'ready' }
    if (target.credentialGeneration && this.deps.currentGeneration && !this.deps.currentGeneration(sessionId)) {
      this.forget(sessionId)
      return { status: 'failed', error: 'platform credential recovery target was released' }
    }
    const activeFlight = this.flights.get(sessionId)
    if (activeFlight) return activeFlight
    this.targets.set(sessionId, target)
    const previous = this.states.get(sessionId)
    if (previous?.credentialGeneration && previous.credentialGeneration !== target.credentialGeneration
      && (previous.status === 'live' || previous.status === 'expired')) {
      this.states.delete(sessionId)
    }

    const lifecycle = this.deps.credentialLifecycleFor?.(target) ?? null
    if (target.credentialGeneration && !lifecycle) {
      const error = `credential lifecycle is undeclared for ${target.providerId}/${target.surface}`
      this.publish(target, { status: 'failed', error })
      return { status: 'failed', error }
    }
    if (target.credentialGeneration && lifecycle?.recovery !== 'reopen') {
      const error = `credential recovery is unsupported for ${target.providerId}/${target.surface}`
      this.publish(target, { status: 'failed', error })
      return { status: 'failed', error }
    }

    const pending = this.pendingObservations.get(sessionId)
    if (pending) {
      this.pendingObservations.delete(sessionId)
      const generation = target.credentialGeneration
      if (generation && pending.generation === generation) {
        this.recordObservation(sessionId, pending)
      }
    }

    const current = this.states.get(sessionId)
    if (current?.status === 'failed') return { status: 'failed', error: current.error ?? 'platform credential recovery failed' }
    if (current?.status === 'reopening') return this.waitForFlight(sessionId)
    if (this.deps.isExpired(sessionId)) this.markExpired(target)

    const next = this.states.get(sessionId)
    if (!next || next.status === 'live') return { status: 'ready' }
    if (next.status === 'failed') return { status: 'failed', error: next.error ?? 'platform credential recovery failed' }
    if (next.status !== 'expired') return { status: 'ready' }

    // An active turn belongs to the old inference owner. Reopening it here would preserve only
    // history and necessarily interrupt the provider's in-flight work. Leave the state expired so
    // the same gate runs again at the turn boundary, then rotate the lease before the next turn.
    if (lifecycle?.originalProcessRefresh !== 'supported') {
      const turnInFlight = this.deps.isTurnInFlight
        ? await this.deps.isTurnInFlight(target)
        : false
      if (turnInFlight) return { status: 'ready' }
    }

    const existing = this.flights.get(sessionId)
    if (existing) return this.waitForFlight(sessionId)
    const run = Symbol(sessionId)
    this.runs.set(sessionId, run)
    const flight = this.reopenOne(target, run, lifecycle)
    this.flights.set(sessionId, flight)
    try {
      return await flight
    } finally {
      if (this.flights.get(sessionId) === flight) this.flights.delete(sessionId)
      if (this.runs.get(sessionId) === run) this.runs.delete(sessionId)
    }
  }

  async retry(sessionId: string): Promise<SessionpageSessionReadyResult> {
    const target = await this.deps.resolveTarget(sessionId) ?? this.targets.get(sessionId) ?? null
    if (!target) return { status: 'failed', error: `session ${sessionId} is not mapped` }
    this.targets.set(sessionId, target)
    const current = this.states.get(sessionId)
    if (current?.status === 'reopening') return this.waitForFlight(sessionId)
    this.publish(target, { status: 'expired' })
    return this.ensureReady(sessionId, 'retry')
  }

  forget(sessionId: string): void {
    this.states.delete(sessionId)
    this.targets.delete(sessionId)
    this.flights.delete(sessionId)
    this.runs.delete(sessionId)
    this.pendingObservations.delete(sessionId)
  }

  private async waitForFlight(sessionId: string): Promise<SessionpageSessionReadyResult> {
    const flight = this.flights.get(sessionId)
    if (!flight) return this.resultFor(sessionId)
    return flight
  }

  private resultFor(sessionId: string): SessionpageSessionReadyResult {
    const state = this.states.get(sessionId)
    return state?.status === 'live'
      ? { status: 'ready' }
      : { status: 'failed', error: state?.error ?? 'platform credential recovery was released or has not admitted' }
  }

  private async reopenOne(
    target: SessionpagePlatformRecoveryTarget,
    run: symbol,
    lifecycle: SessionCredentialLifecycle | null,
  ): Promise<SessionpageSessionReadyResult> {
    const expectedGeneration = target.credentialGeneration
    let admittedGeneration = expectedGeneration
    const operation = lifecycle?.originalProcessRefresh === 'supported' ? 'issue' : 'reopen'
    this.publish(target, { status: 'reopening' })
    try {
      if (lifecycle?.originalProcessRefresh === 'supported') {
        if (!this.deps.refresh) throw new Error('platform credential recovery has no original-process refresh entry')
        await this.deps.refresh(target)
      } else {
        await this.deps.reopen(target)
      }
      if (this.runs.get(target.sessionId) !== run) throw new Error('platform credential recovery was released')
      admittedGeneration = this.deps.currentGeneration
        ? this.deps.currentGeneration(target.sessionId) ?? undefined
        : (await this.deps.resolveTarget(target.sessionId))?.credentialGeneration
      if (expectedGeneration && !this.deps.waitUntilReady) {
        throw new Error('platform credential recovery has no native owner admission waiter')
      }
      await this.deps.waitUntilReady?.(target)
      const resolvedTarget = await this.deps.resolveTarget(target.sessionId)
      if (expectedGeneration && !resolvedTarget) throw new Error('platform credential recovery target was released')
      const refreshedTarget = resolvedTarget ?? target
      const generation = this.deps.currentGeneration
        ? this.deps.currentGeneration(target.sessionId)
        : refreshedTarget.credentialGeneration
      if (expectedGeneration && (!generation || generation === expectedGeneration)) {
        throw new Error('platform credential recovery did not establish a new lease generation')
      }
      if (expectedGeneration && this.deps.isExpired(target.sessionId)) {
        throw new Error('platform credential recovery established an already-expired lease')
      }
      if (this.runs.get(target.sessionId) !== run || generation !== admittedGeneration) {
        throw new Error('platform credential recovery was superseded during admission')
      }
      this.targets.set(target.sessionId, refreshedTarget)
      const observation = generation ? {
          generation,
          source: 'recovery',
          observedAt: new Date().toISOString(),
          leaseExpiresAt: refreshedTarget.expiresAt ?? null,
          operation,
          outcome: 'success',
          classification: 'admitted',
        } satisfies PlatformCredentialRuntimeObservation : null
      this.publish(refreshedTarget, observation ? { status: 'live', observation } : { status: 'live' })
      return { status: 'ready' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const generation = this.deps.currentGeneration
        ? this.deps.currentGeneration(target.sessionId)
        : admittedGeneration
      if (this.runs.get(target.sessionId) !== run) {
        return { status: 'failed', error: message }
      }
      // A current run that created a lease but lost admission to a newer rotation is not a
      // stale run: leaving `reopening` here strands the conversation forever after its flight
      // is removed. Publish a terminal failure for the generation that is actually current;
      // the next user action can retry against that generation.
      const failedTarget = { ...target, credentialGeneration: generation ?? undefined }
      const observation = generation ? {
          generation,
          source: 'recovery',
          observedAt: new Date().toISOString(),
          leaseExpiresAt: target.expiresAt ?? null,
          operation,
          outcome: 'failure',
          classification: operation === 'issue' ? 'refresh-failed' : 'reopen-failed',
        } satisfies PlatformCredentialRuntimeObservation : null
      this.publish(
        failedTarget,
        observation ? { status: 'failed', error: message, observation } : { status: 'failed', error: message },
      )
      return { status: 'failed', error: message }
    }
  }

  private publish(target: SessionpagePlatformRecoveryTarget, state: SessionpagePlatformRecoveryState): void {
    this.states.set(target.sessionId, target.credentialGeneration ? { ...state, credentialGeneration: target.credentialGeneration } : state)
    this.deps.onStateChange?.(target, state)
  }
}
