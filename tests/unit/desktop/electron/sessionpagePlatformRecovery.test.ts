import { describe, expect, it, vi } from 'vitest'
import {
  SessionpagePlatformRecoveryCoordinator,
  type PlatformCredentialRuntimeObservation,
  type SessionpagePlatformRecoveryTarget,
} from '../../../../apps/desktop/electron/sessionpage/sessionpage-platform-recovery'

const target: SessionpagePlatformRecoveryTarget = {
  sessionId: 'conversation-1',
  projectId: 'project-1',
  providerId: 'claude',
  surface: 'tui',
  expiresAt: '2026-09-12T00:00:00.000Z',
}

describe('SessionpagePlatformRecoveryCoordinator', () => {
  const lifecycle = {
    delivery: 'process-config' as const,
    originalProcessRefresh: 'unsupported' as const,
    recovery: 'reopen' as const,
    inferenceOwner: 'serve-process-descendants' as const,
    reopenEntry: 'host-session-reload' as const,
    sourceChangeSession: 'preserve' as const,
  }

  const issue = (generation: string): PlatformCredentialRuntimeObservation => ({
    generation,
    source: 'lease',
    observedAt: '2026-09-17T00:00:00.000Z',
    leaseExpiresAt: '2026-09-17T00:10:00.000Z',
    operation: 'issue',
    outcome: 'success',
    classification: 'issued',
  })

  it('refreshes a helper credential without reopening the inference owner', async () => {
    let generation = 'generation-1'
    const resolveTarget = () => ({ ...target, credentialGeneration: generation })
    const reopen = vi.fn()
    const refresh = vi.fn(async () => { generation = 'generation-2' })
    const coordinator = new SessionpagePlatformRecoveryCoordinator({
      isExpired: () => generation === 'generation-1',
      resolveTarget,
      currentGeneration: () => generation,
      credentialLifecycleFor: () => ({ ...lifecycle, originalProcessRefresh: 'supported' }),
      isTurnInFlight: () => true,
      reopen,
      refresh,
      waitUntilReady: vi.fn(async () => undefined),
    })
    await expect(coordinator.ensureReady(target.sessionId)).resolves.toEqual({ status: 'ready' })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(reopen).not.toHaveBeenCalled()
    expect(coordinator.stateFor(target.sessionId)).toMatchObject({
      status: 'live',
      credentialGeneration: 'generation-2',
    })
  })

  it.each([
    { requestManaged: true, retry: false },
    { requestManaged: false, retry: false },
    { requestManaged: true, retry: true },
  ])('admits proxy messages during rotation while explicit retry still waits ($requestManaged/$retry)', async ({ requestManaged, retry }) => {
    let generation = 'generation-1'
    let release!: () => void
    let began!: () => void
    let finished!: () => void
    const rotating = new Promise<void>(resolve => { began = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const recovered = new Promise<void>(resolve => { finished = resolve })
    const refresh = vi.fn(async () => { began(); await gate; generation = 'generation-2' })
    const coordinator = new SessionpagePlatformRecoveryCoordinator({
      isExpired: () => generation === 'generation-1',
      resolveTarget: () => ({ ...target, credentialGeneration: generation }),
      currentGeneration: () => generation,
      credentialLifecycleFor: () => ({ ...lifecycle, originalProcessRefresh: 'supported' }),
      requestCredentialsManaged: () => requestManaged,
      reopen: vi.fn(), refresh, waitUntilReady: async () => undefined,
      onStateChange: (_target, state) => { if (state.status === 'live') finished() },
    })
    let admitted = false
    const first = (retry ? coordinator.retry(target.sessionId) : coordinator.ensureReady(target.sessionId))
      .then(result => { admitted = true; return result })
    await rotating
    await Promise.resolve()
    expect(admitted).toBe(requestManaged && !retry)
    expect(coordinator.stateFor(target.sessionId)?.status).toBe('reopening')
    let nextAdmitted = false
    const second = coordinator.ensureReady(target.sessionId).then(result => { nextAdmitted = true; return result })
    await Promise.resolve()
    await Promise.resolve()
    expect(nextAdmitted).toBe(requestManaged)
    expect(refresh).toHaveBeenCalledTimes(1)
    release()
    await expect(first).resolves.toEqual({ status: 'ready' })
    await expect(second).resolves.toEqual({ status: 'ready' })
    await recovered
    expect(coordinator.stateFor(target.sessionId)).toMatchObject({ status: 'live', credentialGeneration: 'generation-2' })
  })

  it('does not revive a forgotten recovery or release its message', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const coordinator = new SessionpagePlatformRecoveryCoordinator({
      isExpired: () => true,
      resolveTarget: () => target,
      reopen: async () => gate,
    })
    const pending = coordinator.ensureReady(target.sessionId)
    await Promise.resolve()
    coordinator.forget(target.sessionId)
    release()
    await expect(pending).resolves.toMatchObject({ status: 'failed' })
    expect(coordinator.stateFor(target.sessionId)).toBeNull()
  })

  it('does not accept observations after the current lease was released', () => {
    const coordinator = new SessionpagePlatformRecoveryCoordinator({
      isExpired: () => false,
      resolveTarget: () => null,
      currentGeneration: () => null,
      reopen: vi.fn(),
    })
    expect(coordinator.recordObservation(target.sessionId, issue('generation-1'))).toBe(false)
  })

  it('does not let a queued lease fact clear a failed recovery', async () => {
    const platformTarget = { ...target, credentialGeneration: 'generation-1' }
    let declared = false
    const coordinator = new SessionpagePlatformRecoveryCoordinator({
      isExpired: () => false,
      resolveTarget: () => platformTarget,
      credentialLifecycleFor: () => declared ? lifecycle : null,
      reopen: vi.fn(),
    })
    coordinator.recordObservation(target.sessionId, issue('generation-1'))
    await expect(coordinator.ensureReady(target.sessionId)).resolves.toMatchObject({ status: 'failed' })
    declared = true
    await expect(coordinator.ensureReady(target.sessionId)).resolves.toMatchObject({ status: 'failed' })
  })

  it('defers owner reopen while a turn is in flight and recovers at the turn boundary', async () => {
    const codexTarget = { ...target, providerId: 'codex', credentialGeneration: 'generation-1' }
    let generation = 'generation-1'
    let turnInFlight = true
    const reopen = vi.fn(async () => { generation = 'generation-2' })
    const coordinator = new SessionpagePlatformRecoveryCoordinator({
      isExpired: () => generation === 'generation-1',
      resolveTarget: () => ({ ...codexTarget, credentialGeneration: generation }),
      currentGeneration: () => generation,
      credentialLifecycleFor: () => lifecycle,
      isTurnInFlight: () => turnInFlight,
      reopen,
      waitUntilReady: vi.fn(async () => undefined),
    })
    coordinator.markExpired(codexTarget)

    await expect(coordinator.ensureReady(codexTarget.sessionId)).resolves.toEqual({ status: 'ready' })
    expect(reopen).not.toHaveBeenCalled()
    expect(coordinator.stateFor(codexTarget.sessionId)?.status).toBe('expired')

    turnInFlight = false
    await expect(coordinator.ensureReady(codexTarget.sessionId, 'turn-end')).resolves.toEqual({ status: 'ready' })
    expect(reopen).toHaveBeenCalledTimes(1)
    expect(coordinator.stateFor(codexTarget.sessionId)).toMatchObject({
      status: 'live',
      credentialGeneration: 'generation-2',
    })
  })

  it('does not admit a generation replaced during native admission', async () => {
    let generation = 'generation-1'
    let replaced = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const coordinator = new SessionpagePlatformRecoveryCoordinator({
      isExpired: () => generation === 'generation-1',
      resolveTarget: () => ({ ...target, credentialGeneration: generation }),
      currentGeneration: () => generation,
      credentialLifecycleFor: () => lifecycle,
      reopen: async () => { generation = replaced ? 'generation-4' : 'generation-2' },
      waitUntilReady: async () => {
        if (!replaced) { replaced = true; generation = 'generation-3'; await gate }
      },
    })
    const pending = coordinator.ensureReady(target.sessionId)
    await Promise.resolve()
    await Promise.resolve()
    release()
    await expect(pending).resolves.toMatchObject({ status: 'failed' })
    expect(coordinator.stateFor(target.sessionId)).toMatchObject({ status: 'failed', credentialGeneration: 'generation-3' })
    await expect(coordinator.retry(target.sessionId)).resolves.toEqual({ status: 'ready' })
    expect(coordinator.stateFor(target.sessionId)).toMatchObject({ status: 'live', credentialGeneration: 'generation-4' })
  })

  it('keeps an issue observation emitted before target registration', async () => {
    const opencodeTarget: SessionpagePlatformRecoveryTarget = {
      ...target,
      providerId: 'opencode',
      credentialGeneration: 'generation-1',
    }
    const coordinator = new SessionpagePlatformRecoveryCoordinator({
      isExpired: () => false,
      resolveTarget: () => opencodeTarget,
      reopen: vi.fn(),
      credentialLifecycleFor: () => lifecycle,
    })
    expect(coordinator.recordObservation(opencodeTarget.sessionId, issue('generation-1'))).toBe(true)
    await expect(coordinator.ensureReady(opencodeTarget.sessionId)).resolves.toEqual({ status: 'ready' })
    expect(coordinator.stateFor(opencodeTarget.sessionId)?.observation?.operation).toBe('issue')
  })

  it('fails closed when a platform target has no lifecycle declaration', async () => {
    const codexTarget: SessionpagePlatformRecoveryTarget = {
      ...target,
      providerId: 'codex',
      credentialGeneration: 'generation-1',
    }
    const coordinator = new SessionpagePlatformRecoveryCoordinator({
      isExpired: () => true,
      resolveTarget: () => codexTarget,
      reopen: vi.fn(),
      credentialLifecycleFor: () => null,
    })
    await expect(coordinator.ensureReady(codexTarget.sessionId)).resolves.toEqual({
      status: 'failed',
      error: 'credential lifecycle is undeclared for codex/tui',
    })
    expect(coordinator.stateFor(codexTarget.sessionId)?.status).toBe('failed')
  })

  it('does not publish live when reopen leaves the lease generation unchanged', async () => {
    const opencodeTarget: SessionpagePlatformRecoveryTarget = {
      ...target,
      providerId: 'opencode',
      credentialGeneration: 'generation-1',
    }
    const coordinator = new SessionpagePlatformRecoveryCoordinator({
      isExpired: () => true,
      resolveTarget: () => opencodeTarget,
      reopen: vi.fn(),
      waitUntilReady: vi.fn(async () => undefined),
      credentialLifecycleFor: () => lifecycle,
      currentGeneration: () => 'generation-1',
    })
    await expect(coordinator.ensureReady(opencodeTarget.sessionId)).resolves.toEqual({
      status: 'failed',
      error: 'platform credential recovery did not establish a new lease generation',
    })
    expect(coordinator.stateFor(opencodeTarget.sessionId)?.status).toBe('failed')
  })

  it('drops late observations from an older lease generation', () => {
    const codexTarget: SessionpagePlatformRecoveryTarget = {
      ...target,
      providerId: 'codex',
      surface: 'acp',
      credentialGeneration: 'generation-1',
    }
    let currentGeneration = 'generation-1'
    const coordinator = new SessionpagePlatformRecoveryCoordinator({
      isExpired: () => false,
      resolveTarget: () => codexTarget,
      reopen: vi.fn(),
      currentGeneration: () => currentGeneration,
    })
    coordinator.markExpired(codexTarget)
    currentGeneration = 'generation-2'

    expect(coordinator.recordObservation(codexTarget.sessionId, {
      generation: 'generation-1',
      source: 'real-request',
      observedAt: '2026-09-17T00:00:00.000Z',
      leaseExpiresAt: codexTarget.expiresAt ?? null,
      operation: 'request',
      outcome: 'success',
      classification: 'authenticated',
    })).toBe(false)
    expect(coordinator.stateFor(codexTarget.sessionId)).toMatchObject({
      status: 'expired',
      observation: {
        generation: 'generation-1',
        operation: 'expiry',
        outcome: 'observed',
        classification: 'wall-clock-expired',
      },
    })

    currentGeneration = 'generation-2'
    expect(coordinator.recordObservation(codexTarget.sessionId, {
      generation: 'generation-2',
      source: 'real-request',
      observedAt: '2026-09-17T00:00:01.000Z',
      leaseExpiresAt: codexTarget.expiresAt ?? null,
      operation: 'request',
      outcome: 'failure',
      classification: 'gateway-502',
    })).toBe(true)
    expect(coordinator.stateFor(codexTarget.sessionId)?.observation).toMatchObject({
      generation: 'generation-2',
      classification: 'gateway-502',
    })
  })

  it('coalesces concurrent use triggers into one reopen and returns ready to both', async () => {
    let expired = true
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const reopen = vi.fn(async () => { await gate; expired = false })
    const coordinator = new SessionpagePlatformRecoveryCoordinator({
      isExpired: () => expired,
      resolveTarget: () => target,
      reopen,
    })
    coordinator.markExpired(target)

    const first = coordinator.ensureReady(target.sessionId, 'chat-send')
    const second = coordinator.ensureReady(target.sessionId, 'session-direct')
    await Promise.resolve()
    expect(reopen).toHaveBeenCalledTimes(1)
    release()
    await expect(first).resolves.toEqual({ status: 'ready' })
    await expect(second).resolves.toEqual({ status: 'ready' })
    expect(coordinator.stateFor(target.sessionId)).toEqual({ status: 'live' })
  })

  it('waits for provider admission before publishing live to callers', async () => {
    let expired = true
    let releaseReady!: () => void
    const ready = new Promise<void>((resolve) => { releaseReady = resolve })
    const reopen = vi.fn(async () => { expired = false })
    const waitUntilReady = vi.fn(async () => ready)
    const coordinator = new SessionpagePlatformRecoveryCoordinator({
      isExpired: () => expired,
      resolveTarget: () => target,
      reopen,
      waitUntilReady,
    })
    coordinator.markExpired(target)

    let settled = false
    const pending = coordinator.ensureReady(target.sessionId).then(() => { settled = true })
    await vi.waitFor(() => expect(waitUntilReady).toHaveBeenCalledWith(target))
    expect(reopen).toHaveBeenCalledTimes(1)
    expect(waitUntilReady).toHaveBeenCalledWith(target)
    expect(settled).toBe(false)
    expect(coordinator.stateFor(target.sessionId)).toEqual({ status: 'reopening' })

    releaseReady()
    await pending
    expect(settled).toBe(true)
    expect(coordinator.stateFor(target.sessionId)).toEqual({ status: 'live' })
  })

  it('returns failed without reopening again until an explicit retry', async () => {
    let attempts = 0
    const coordinator = new SessionpagePlatformRecoveryCoordinator({
      isExpired: () => true,
      resolveTarget: () => target,
      reopen: async () => {
        attempts += 1
        throw new Error('gateway rejected replacement credential')
      },
    })
    coordinator.markExpired(target)

    await expect(coordinator.ensureReady(target.sessionId)).resolves.toEqual({
      status: 'failed',
      error: 'gateway rejected replacement credential',
    })
    await expect(coordinator.ensureReady(target.sessionId)).resolves.toEqual({
      status: 'failed',
      error: 'gateway rejected replacement credential',
    })
    expect(attempts).toBe(1)
  })

  it('clears failed state and returns live after an explicit retry succeeds', async () => {
    let expired = true
    let attempts = 0
    const coordinator = new SessionpagePlatformRecoveryCoordinator({
      isExpired: () => expired,
      resolveTarget: () => target,
      reopen: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('replacement credential unavailable')
        expired = false
      },
    })
    coordinator.markExpired(target)

    await expect(coordinator.ensureReady(target.sessionId)).resolves.toEqual({
      status: 'failed',
      error: 'replacement credential unavailable',
    })
    await expect(coordinator.retry(target.sessionId)).resolves.toEqual({ status: 'ready' })
    expect(coordinator.stateFor(target.sessionId)).toEqual({ status: 'live' })
    expect(attempts).toBe(2)
  })
})
