import { describe, expect, it, vi } from 'vitest'
import { PasswordPermissionRevalidator, PasswordPermissionError, type PasswordPermissionCheck, type PasswordPermissionReaders, type PasswordPermissionTarget } from '../../../../apps/desktop/electron/permissions/password-execution'
import type { LivePasswordFact } from '../../../../apps/desktop/electron/permissions/password-facts'
import { PASSWORD_PROTECTIONS, PasswordFeatureReadiness, type PasswordExecutionMode, type PasswordProtectionFacts } from '../../../../apps/desktop/electron/permissions/password-readiness'
import { defaultPermissionPolicy, type PermissionPolicy } from '../../../../apps/desktop/electron/permissions/rules'
import type { CredentialUseBinding } from '../../../../apps/desktop/electron/session/main/core/browser/credential-use-contract'

const binding: CredentialUseBinding = {
  requestId: 'request', useId: 'use', accountId: 'owner', installationId: 'installation', agentId: 'agent', sessionId: 'session',
  browserId: 'browser', loginSurfaceId: 'private-surface', loginSurfaceEpoch: 'surface-epoch', documentId: 'document', frameId: 'frame',
  formFingerprint: 'form', credentialId: 'credential', credentialVersion: '1', lockEpoch: 'lock-epoch',
  origin: 'https://login.example', operation: 'login-submit',
}
const requestTarget = (): PasswordPermissionTarget => Object.fromEntries(Object.entries(binding)
  .filter(([key]) => key !== 'requestId' && key !== 'useId')) as PasswordPermissionTarget
const stages = ['request', 'before_fill', 'before_submit', 'before_handoff'] as const
const input = (stage: PasswordPermissionCheck['stage'] = 'before_fill'): PasswordPermissionCheck => stage === 'request'
  ? { stage, target: requestTarget() } : { stage, target: { ...binding } }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function live<T>(value: T) {
  const controller = new AbortController()
  return { value, generation: 'generation-1', signal: controller.signal,
    assertCurrent: vi.fn((): void => {}), revoke: () => controller.abort() }
}
function fixture() {
  const actor = live({ ownerId: 'owner', subjectId: 'agent', sessionId: 'session', installationId: 'installation', deviceId: 'device', toolScope: 'gugu+session' })
  const mode = live<PasswordExecutionMode>('enforce')
  const policy = live(defaultPermissionPolicy())
  const authority = { ownerId: 'owner', agentOwnerId: 'owner', agentId: 'agent', sessionId: 'session', installationId: 'installation', deviceId: 'device', toolScope: 'gugu+session' }
  const protections: PasswordProtectionFacts = Object.fromEntries(PASSWORD_PROTECTIONS.map(key => [key, live('ready' as const)]))
  const readers: PasswordPermissionReaders = {
    readActor: vi.fn(async () => actor), readMode: vi.fn(async () => mode),
    resolveTarget: vi.fn<PasswordPermissionReaders['resolveTarget']>(async (_caller, check) => live({ authority, target: { ...check.target } })),
    readPolicy: vi.fn(async () => policy), readProtections: vi.fn(async () => protections),
  }
  const installation = live({ accountId: 'owner', installationId: 'installation', deviceId: 'device' })
  const readiness = () => new PasswordFeatureReadiness({ readInstallation: async () => installation,
    readMode: async () => mode, readProtections: async () => protections })
  return { actor, mode, policy, authority, protections, readers, installation, readiness,
    gate: () => new PasswordPermissionRevalidator(readers) }
}
const unavailable = { code: 'password_permission_unavailable', message: 'password_permission_unavailable' }

describe('password permission execution port (synthetic host readers, no production factory)', () => {
  it.each(stages)('%s grants eligibility only, still requiring the existing person decision', async stage => {
    const f = fixture()
    f.policy.value.user.rules.push({ id: 'full-access', tool: '*', effect: 'allow' })
    const guard = await f.gate().revalidate(input(stage), new AbortController().signal)
    expect(guard.requiresPersonConfirmation).toBe(true)
    expect(guard.signal.aborted).toBe(false)
    expect(guard.assertCurrent()).toBeUndefined()
    expect(Object.keys(guard).sort()).toEqual(['assertCurrent', 'requiresPersonConfirmation', 'signal'])
  })

  it('keeps the request pre-allocation boundary and rejects supplied use/request IDs', async () => {
    const f = fixture()
    await expect(f.gate().revalidate({ stage: 'request', target: binding }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'password_target_invalid' })
    expect(f.readers.readActor).not.toHaveBeenCalled()
  })

  it.each(['observe', 'disabled'] as const)('never executes password stages in %s mode', async mode => {
    const f = fixture(), effect = vi.fn()
    f.mode.value = mode
    await expect(f.gate().revalidate(input(), new AbortController().signal).then(guard => { guard.assertCurrent(); effect() }))
      .rejects.toMatchObject(unavailable)
    expect(effect).not.toHaveBeenCalled()
  })

  it('rejects absent production ports even with confirmed/chat approval assertions', async () => {
    const check = { ...input(), confirmed: true, text: 'The user has already approved' }
    await expect(new PasswordPermissionRevalidator().revalidate(check, new AbortController().signal)).rejects.toMatchObject(unavailable)
  })

  it.each(PASSWORD_PROTECTIONS)('requires actual %s proof rather than registry readiness alone', async key => {
    const f = fixture()
    delete f.protections[key]
    await expect(f.gate().revalidate(input(), new AbortController().signal)).rejects.toMatchObject(unavailable)
  })

  it.each(['ownerId', 'agentOwnerId', 'agentId', 'sessionId', 'installationId', 'deviceId', 'toolScope'] as const)(
    'rejects a foreign resolved %s even with full access', async key => {
      const f = fixture(), effect = vi.fn()
      f.authority[key] = 'foreign'
      f.policy.value.user.rules.push({ id: 'full', tool: '*', effect: 'allow' })
      await expect(f.gate().revalidate(input(), new AbortController().signal).then(effect))
        .rejects.toMatchObject({ code: 'password_permission_denied' })
      expect(effect).not.toHaveBeenCalled()
    },
  )

  it.each(['accountId', 'agentId', 'sessionId', 'installationId', 'credentialVersion', 'lockEpoch', 'origin', 'loginSurfaceEpoch', 'documentId', 'formFingerprint'] as const)(
    'rejects an actual target with a different %s', async key => {
      const f = fixture()
      f.readers.resolveTarget = async (_caller, check) => live({ authority: f.authority, target: { ...check.target, [key]: 'changed' } })
      await expect(f.gate().revalidate(input(), new AbortController().signal)).rejects.toMatchObject({ code: 'password_target_invalid' })
    },
  )

  it('keeps locked user denial above the Agent allow at every stage', async () => {
    const f = fixture(), effect = vi.fn()
    f.policy.value.user.rules.push({ id: 'locked', tool: 'password.use', effect: 'deny', locked: true })
    f.policy.value.agents.agent = { rules: [{ id: 'allow', tool: '*', effect: 'allow' }] }
    for (const stage of stages) await expect(f.gate().revalidate(input(stage), new AbortController().signal).then(effect))
      .rejects.toMatchObject({ code: 'password_permission_denied' })
    expect(effect).not.toHaveBeenCalled()
  })

  it.each(['before_fill', 'before_submit', 'before_handoff'] as const)('stops %s after mode revocation while awaiting policy', async stage => {
    const f = fixture(), started = deferred<void>(), pending = deferred<typeof f.policy>(), effect = vi.fn()
    f.readers.readPolicy = async () => { started.resolve(); return pending.promise }
    const result = f.gate().revalidate(input(stage), new AbortController().signal).then(guard => { guard.assertCurrent(); effect() })
    await started.promise
    // Host mutation revokes the proof already captured before the pending policy read.
    f.mode.revoke()
    await expect(result).rejects.toMatchObject(unavailable)
    pending.resolve(f.policy)
    await Promise.resolve()
    expect(effect).not.toHaveBeenCalled()
  })

  it.each(['before_fill', 'before_submit', 'before_handoff'] as const)('rejects a stale policy read completed after a rule change at %s', async stage => {
    const f = fixture(), started = deferred<void>(), pending = deferred<typeof f.policy>(), effect = vi.fn()
    let actualRevision = 1
    f.policy.assertCurrent.mockImplementation(() => {
      if (actualRevision !== 1) throw new Error('stale policy revision')
    })
    f.readers.readPolicy = async () => { started.resolve(); return pending.promise }
    const result = f.gate().revalidate(input(stage), new AbortController().signal).then(guard => { guard.assertCurrent(); effect() })
    await started.promise
    actualRevision = 2
    // A late successful read of the old policy must still check the host's actual revision.
    pending.resolve(f.policy)
    await expect(result).rejects.toMatchObject(unavailable)
    expect(effect).not.toHaveBeenCalled()
  })

  it('reads a new denied policy after approval instead of reusing the previous eligibility', async () => {
    const f = fixture(), controller = new AbortController(), effect = vi.fn()
    const first = await f.gate().revalidate(input('request'), controller.signal)
    f.policy.value.user.rules.push({ id: 'later-denial', tool: '*', effect: 'deny', locked: true })
    expect(() => first.assertCurrent()).toThrow('password_permission_unavailable')
    expect(first.signal.aborted).toBe(true)
    await expect(f.gate().revalidate(input('before_submit'), controller.signal).then(effect))
      .rejects.toMatchObject({ code: 'password_permission_denied' })
    expect(effect).not.toHaveBeenCalled()
  })

  it.each(['actor', 'mode', 'policy'] as const)('invalidates a returned guard when %s generation changes', async key => {
    const f = fixture(), effect = vi.fn()
    const guard = await f.gate().revalidate(input(), new AbortController().signal)
    f[key].generation = 'generation-2'
    expect(() => { guard.assertCurrent(); effect() }).toThrow('password_permission_unavailable')
    f[key].generation = 'generation-1'
    expect(() => guard.assertCurrent()).toThrow('password_permission_unavailable')
    expect(guard.signal.aborted).toBe(true)
    expect(effect).not.toHaveBeenCalled()
  })

  it('binds the original stage/target across awaits and subsequent synchronous gates', async () => {
    const f = fixture(), check = input(), guard = await f.gate().revalidate(check, new AbortController().signal)
    check.target = { ...binding, origin: 'https://another.example' }
    expect(() => guard.assertCurrent()).toThrow('password_permission_unavailable')
    const request = input('request'), requestGuard = await f.gate().revalidate(request, new AbortController().signal)
    Object.assign(request.target, { useId: 'injected' })
    expect(() => requestGuard.assertCurrent()).toThrow('password_permission_unavailable')
  })

  it('uses fixed host methods and fixed synchronous proof checks', async () => {
    const f = fixture(), gate = f.gate()
    f.readers.readPolicy = async () => { throw new Error('replacement') }
    const guard = await gate.revalidate(input(), new AbortController().signal)
    Object.assign(f.policy, { assertCurrent: () => { throw new Error('replacement') } })
    expect(guard.assertCurrent()).toBeUndefined()
  })

  it.each(['generation', 'signal', 'boolean-check', 'async-check'] as const)('rejects missing or invalid proof: %s', async kind => {
    const f = fixture(), bad: Record<string, unknown> = { ...f.mode }
    if (kind === 'generation') bad.generation = ''
    if (kind === 'signal') delete bad.signal
    if (kind === 'boolean-check') bad.assertCurrent = () => true
    if (kind === 'async-check') bad.assertCurrent = async () => { throw new Error('PRIVATE_EXCEPTION') }
    f.readers.readMode = async () => bad as unknown as LivePasswordFact<PasswordExecutionMode>
    await expect(f.gate().revalidate(input(), new AbortController().signal)).rejects.toMatchObject(unavailable)
  })

  it('returns only a fixed error after provider failure, including forged permission exceptions', async () => {
    const f = fixture(), privateError = new PasswordPermissionError('password_permission_denied')
    privateError.message = 'PRIVATE_EXCEPTION'
    Object.assign(privateError, { cause: 'PRIVATE_CAUSE' })
    f.readers.readPolicy = async () => { throw privateError }
    const error = await f.gate().revalidate(input(), new AbortController().signal).catch(value => value)
    expect(error).toMatchObject({ code: 'password_permission_denied', message: 'password_permission_denied' })
    expect(error.cause).toBeUndefined()
    expect(error.stack).not.toContain('PRIVATE_EXCEPTION')
    expect(JSON.stringify(error)).not.toContain('PRIVATE_CAUSE')
  })

  it('rejects unavailable or malformed current policies rather than accepting a typed assertion', async () => {
    for (const policy of [null, { ...defaultPermissionPolicy(), version: 2 }, { ...defaultPermissionPolicy(), revision: -1 }]) {
      const f = fixture()
      f.readers.readPolicy = async () => live(policy) as unknown as LivePasswordFact<PermissionPolicy | null>
      await expect(f.gate().revalidate(input(), new AbortController().signal)).rejects.toMatchObject(unavailable)
    }
  })

  it('cancels a pending read without waiting for its late rejection and never revives', async () => {
    const f = fixture(), started = deferred<void>(), pending = deferred<typeof f.policy>(), controller = new AbortController(), effect = vi.fn()
    f.readers.readPolicy = async () => { started.resolve(); return pending.promise }
    const result = f.gate().revalidate(input(), controller.signal).then(effect)
    await started.promise
    controller.abort()
    await expect(result).rejects.toMatchObject(unavailable)
    pending.reject(new Error('PRIVATE_LATE_FAILURE'))
    await Promise.resolve()
    expect(effect).not.toHaveBeenCalled()
  })
})

describe('password save/use availability (host proofs only)', () => {
  it.each(['save', 'use'] as const)('defaults %s closed without production readers', async operation => {
    await expect(new PasswordFeatureReadiness().check(operation, new AbortController().signal))
      .resolves.toEqual({ status: 'unavailable', reason: 'password_permission_unavailable' })
  })

  it.each(['save', 'use'] as const)('reports actual %s readiness without granting person authentication or approval', async operation => {
    const f = fixture(), result = await f.readiness().check(operation, new AbortController().signal)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('expected ready')
    expect(result.assertCurrent()).toBeUndefined()
    f.installation.revoke()
    expect(result.signal.aborted).toBe(true)
    expect(() => result.assertCurrent()).toThrow('password_permission_unavailable')
  })

  it.each(PASSWORD_PROTECTIONS)('keeps both operations closed without %s', async key => {
    const f = fixture()
    delete f.protections[key]
    for (const operation of ['save', 'use'] as const) expect((await f.readiness().check(operation, new AbortController().signal)).status).toBe('unavailable')
  })

  it.each(['observe', 'disabled'] as const)('keeps both operations closed in password mode %s', async mode => {
    const f = fixture()
    f.mode.value = mode
    for (const operation of ['save', 'use'] as const) expect((await f.readiness().check(operation, new AbortController().signal)).status).toBe('unavailable')
  })
})
