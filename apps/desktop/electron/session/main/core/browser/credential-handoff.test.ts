import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CredentialHandoff, type CredentialCompletion, type CredentialUseSettlement, type PreparedCredentialHandoff } from './credential-handoff';
import type { CredentialUseBinding, VaultUseCapability } from './credential-use-contract';
import type { PostUseAuditProof, PostUseAuditResult, UseOutcomeContext } from './credential-settlement-contract';
import { CredentialHandoffRegistry } from './credential-handoff-registry';
import { prepareFreshCredentialHandoffTarget } from './credential-handoff-target';
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const binding: Mutable<CredentialUseBinding> = { requestId: randomUUID(), useId: randomUUID(), accountId: randomUUID(),
    installationId: randomUUID(), agentId: randomUUID(), sessionId: randomUUID(), browserId: randomUUID(),
    loginSurfaceId: randomUUID(), loginSurfaceEpoch: randomUUID(), documentId: randomUUID(), frameId: randomUUID(),
    formFingerprint: randomUUID(), credentialId: randomUUID(), credentialVersion: '1', lockEpoch: randomUUID(),
    origin: 'https://login.example.test:8443', operation: 'login-submit' };
  const capability = Object.freeze({}) as VaultUseCapability, person = {};
  const completion: Mutable<CredentialCompletion> = { loginSurfaceId: binding.loginSurfaceId, loginSurfaceEpoch: binding.loginSurfaceEpoch,
    surfaceEpoch: binding.loginSurfaceEpoch, documentId: randomUUID(), documentEpoch: randomUUID(),
    topDocumentChanged: true, filledPasswordFieldsAbsent: true, requiresPersonInteraction: false };
  const commit = vi.fn(async () => {});
  const discard = vi.fn(async () => {}), retract = vi.fn(() => {}), confirm = vi.fn(() => {});
  const host = { assertCurrent: vi.fn((_binding: CredentialUseBinding) => {}),
    readCompletion: vi.fn(async (_binding: CredentialUseBinding): Promise<CredentialCompletion> => ({ ...completion })),
    verifyLocalContinue: vi.fn((_binding: CredentialUseBinding, evidence: unknown) => evidence === person),
    prepareHandoff: vi.fn(async (_binding: CredentialUseBinding): Promise<PreparedCredentialHandoff> => ({ commit, discard, retract, confirm })) };
  const surface = { clearFilledFields: vi.fn(async (_binding: CredentialUseBinding) => ({ status: 'cleared' as const })),
    destroy: vi.fn(async (_binding: CredentialUseBinding, _epoch?: string) => ({ status: 'destroyed' as const })) };
  const artifacts = { quiesce: vi.fn(async () => true), clear: vi.fn(async () => true), verify: vi.fn(async () => true) };
  const proofs = new WeakMap<PostUseAuditProof, UseOutcomeContext & { eventId: string; recordId: string }>();
  function issue(outcome: UseOutcomeContext['outcome'] = 'submitted_unconfirmed', effectPossible = true): PostUseAuditResult {
    const proof = Object.freeze({}) as PostUseAuditProof;
    const eventId = randomUUID(), recordId = randomUUID();
    proofs.set(proof, { capability, binding: { ...binding }, outcome, effectPossible, eventId, recordId });
    return { status: 'recorded', eventId, recordId, proof };
  }
  const audit = { appendOutcome: vi.fn(async (context: UseOutcomeContext) => issue(context.outcome, context.effectPossible)),
    matches: vi.fn((receipt: Extract<PostUseAuditResult, { status: 'recorded' }>, context: UseOutcomeContext) => {
      const previous = proofs.get(receipt.proof);
      return Boolean(previous && previous.capability === context.capability && previous.outcome === context.outcome
        && previous.effectPossible === context.effectPossible && previous.eventId === receipt.eventId && previous.recordId === receipt.recordId
        && (Object.keys(binding) as (keyof CredentialUseBinding)[]).every(key => previous.binding[key] === context.binding[key]));
    }) };
  const revocation = new AbortController();
  const handoff = new CredentialHandoff(binding, capability, host, surface, artifacts, audit, revocation.signal);
  const settlement: Mutable<CredentialUseSettlement> = { outcome: 'submitted_unconfirmed', effectPossible: true,
    audit: issue() };
  return { binding, capability, person, completion, commit, discard, retract, confirm, host, surface, artifacts, handoff, settlement, audit, issue, revocation,
    settle: (value = settlement) => handoff.settle(capability, binding, value) };
}

describe('private credential session handoff', () => {
  it('automatically hands back only after durable outcome, retirement and drained artifacts', async () => {
    const f = fixture();
    expect((await f.settle()).handoff).toBe('handed_back');
    expect(f.surface.destroy).toHaveBeenCalledWith(f.binding, f.completion.documentEpoch);
    expect(f.artifacts.quiesce).toHaveBeenCalledTimes(2);
    expect(f.commit).toHaveBeenCalledOnce();
    expect((await f.handoff.refresh()).outcome).toBe('submitted_unconfirmed');
    expect(f.commit).toHaveBeenCalledOnce();
  });

  it('does not interpret cleanup or a confirmed webpage as an audit receipt', async () => {
    const f = fixture();
    expect((await f.handoff.cleanup(f.binding.useId)).status).toBe('cleaned');
    expect((await f.handoff.refresh()).handoff).toBe('isolated_login_active');
    expect(f.commit).not.toHaveBeenCalled();
    expect((await f.settle({ ...f.settlement, outcome: 'login_confirmed', audit: f.issue('login_confirmed') })).handoff).toBe('handed_back');
  });

  it('does not scrub or destroy a still-running sink on a navigation event', async () => {
    const f = fixture();
    await f.handoff.refresh();
    expect(f.surface.clearFilledFields).not.toHaveBeenCalled();
    expect(f.surface.destroy).not.toHaveBeenCalled();
  });

  it('preserves the second-factor page, scrubs values, then rechecks before person continuation', async () => {
    const f = fixture();
    f.completion.requiresPersonInteraction = true;
    expect((await f.settle({ ...f.settlement, outcome: 'person_interaction_required', audit: f.issue('person_interaction_required') })).canRequestContinue).toBe(true);
    expect(f.surface.clearFilledFields).toHaveBeenCalledOnce();
    expect(f.surface.destroy).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    f.completion.requiresPersonInteraction = false;
    expect((await f.handoff.requestContinue(f.person)).handoff).toBe('handed_back');
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.audit.appendOutcome).toHaveBeenCalledOnce();
    expect(f.handoff.view().outcome).toBe('submitted_unconfirmed');
  });

  it('permits trusted continuation for same-document login only after a fresh field check', async () => {
    const f = fixture();
    f.completion.topDocumentChanged = false;
    f.completion.documentEpoch = f.binding.documentId;
    f.completion.documentId = f.binding.documentId;
    expect((await f.settle()).handoff).toBe('person_interaction_required');
    expect((await f.handoff.requestContinue(f.person)).handoff).toBe('handed_back');
  });

  it('person continuation cannot override a remaining filled password field or challenge', async () => {
    const f = fixture();
    f.completion.filledPasswordFieldsAbsent = false;
    await f.settle();
    await f.handoff.requestContinue(f.person);
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.surface.destroy).not.toHaveBeenCalled();
  });

  it('rejects chat/serialized person claims and never exposes private surface identity in views', async () => {
    const f = fixture();
    f.completion.topDocumentChanged = false;
    await f.settle();
    await expect(f.handoff.requestContinue({ confirmed: true })).rejects.toThrow('local_person_required');
    expect(JSON.stringify(f.handoff.view()).includes(f.binding.loginSurfaceId)).toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'uncertain'] as const)('cleans on %s audit and refuses a late recorded callback', async status => {
    const f = fixture();
    expect((await f.settle({ ...f.settlement, audit: { status } })).handoff).toBe('isolated_login_retained');
    expect(f.surface.destroy).toHaveBeenCalledOnce();
    await f.settle();
    await f.handoff.refresh();
    await f.handoff.requestContinue(f.person);
    expect(f.handoff.view().reason).toBe('audit_unavailable');
    expect(f.commit).not.toHaveBeenCalled();
  });

  it.each(['failed', 'uncertain', 'unavailable'] as const)('retains an %s outcome even with reliable audit', async outcome => {
    const f = fixture();
    expect((await f.settle({ ...f.settlement, outcome })).handoff).toBe('isolated_login_retained');
    expect(f.surface.destroy).toHaveBeenCalledOnce();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it.each(['quiesce', 'clear', 'verify'] as const)('latches %s failure and still attempts all cleanup stages', async stage => {
    const f = fixture();
    f.artifacts[stage].mockResolvedValueOnce(false);
    expect((await f.settle()).reason).toBe('cleanup_unconfirmed');
    expect(f.surface.destroy).toHaveBeenCalledOnce();
    expect(f.artifacts.clear).toHaveBeenCalled();
    expect(f.artifacts.verify).toHaveBeenCalled();
    await f.handoff.requestContinue(f.person);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('does not release on a thrown page/console error and never returns its payload', async () => {
    const f = fixture(), privateError = randomUUID();
    f.surface.clearFilledFields.mockRejectedValueOnce(new Error(privateError));
    const view = await f.settle();
    expect(view.reason).toBe('cleanup_unconfirmed');
    expect(JSON.stringify(view).includes(privateError)).toBe(false);
    expect(f.surface.destroy).toHaveBeenCalledOnce();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('rejects cloned capability, changed use and binding mutations before accepting a receipt', async () => {
    const f = fixture();
    await expect(f.handoff.settle({} as VaultUseCapability, f.binding, f.settlement)).rejects.toThrow();
    for (const key of Object.keys(f.binding) as (keyof CredentialUseBinding)[]) {
      await expect(f.handoff.settle(f.capability, { ...f.binding, [key]: randomUUID() }, f.settlement)).rejects.toThrow();
    }
    expect(f.commit).not.toHaveBeenCalled();
    expect((await f.settle()).handoff).toBe('handed_back');
  });

  it('ignores an unknown cleanup use id', async () => {
    const f = fixture();
    expect((await f.handoff.cleanup(randomUUID())).status).toBe('isolated_login_retained');
    expect(f.surface.clearFilledFields).not.toHaveBeenCalled();
  });

  it('rejects stale surface and impossible top-document completion evidence', async () => {
    for (const kind of ['surface', 'document'] as const) {
      const f = fixture();
      if (kind === 'surface') f.completion.surfaceEpoch = randomUUID();
      else f.completion.documentId = f.binding.documentId;
      expect((await f.settle()).handoff).toBe('isolated_login_retained');
      expect(f.commit).not.toHaveBeenCalled();
    }
  });

  it('copies settlement and binding instead of retaining mutable caller-owned objects', async () => {
    const f = fixture(), wait = deferred<CredentialCompletion>();
    f.host.readCompletion.mockReturnValueOnce(wait.promise);
    const pending = f.settle();
    f.settlement.audit = { status: 'unavailable' };
    f.binding.origin = 'https://other.example.test';
    wait.resolve(f.completion);
    expect((await pending).handoff).toBe('handed_back');
    expect(f.host.prepareHandoff.mock.calls[0][0].origin).toBe('https://login.example.test:8443');
  });

  it('invalidates synchronously during completion I/O and still destroys and drains', async () => {
    const f = fixture(), wait = deferred<CredentialCompletion>(), entered = deferred<void>();
    f.host.readCompletion.mockImplementationOnce(() => { entered.resolve(); return wait.promise; });
    const pending = f.settle();
    await entered.promise;
    f.handoff.invalidate();
    wait.resolve(f.completion);
    expect((await pending).handoff).toBe('isolated_login_retained');
    expect(f.surface.destroy).toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('does not commit after lock/revoke while async handoff preparation waits', async () => {
    const f = fixture(), wait = deferred<PreparedCredentialHandoff>(), entered = deferred<void>();
    f.host.prepareHandoff.mockImplementationOnce(() => { entered.resolve(); return wait.promise; });
    const pending = f.settle();
    await entered.promise;
    f.handoff.invalidate();
    wait.resolve({ commit: f.commit, discard: f.discard, retract: f.retract, confirm: f.confirm });
    expect((await pending).handoff).toBe('isolated_login_retained');
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.discard).toHaveBeenCalledOnce();
    await f.handoff.refresh();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it.each(['during-publish', 'before-commit-resolution'] as const)('keeps Agent admission blocked on revocation %s', async timing => {
    const f = fixture();
    let blocked = true, published = false, destroyed = false, admissionDuringPublish = false;
    const destination = {
      loadOrigin: async () => {},
      publish: () => {
        published = true; admissionDuringPublish = !blocked;
        if (timing === 'during-publish') f.revocation.abort();
        else queueMicrotask(() => f.revocation.abort());
        return { status: 'published' as const };
      },
      retract: vi.fn(() => { blocked = true; }),
      confirm: vi.fn(() => { blocked = false; }),
      dispose: vi.fn(async () => { destroyed = true; published = false; }),
    };
    f.host.prepareHandoff.mockImplementationOnce(binding => prepareFreshCredentialHandoffTarget(binding, {
      assertCurrent: () => { if (f.revocation.signal.aborted) throw new Error('revoked'); }, prepare: async () => destination,
    }));
    expect((await f.settle()).handoff).toBe('isolated_login_retained');
    expect(admissionDuringPublish).toBe(false);
    expect(blocked && destroyed && !published).toBe(true);
    expect(destination.confirm.mock.calls.length).toBe(0);
    expect(destination.dispose.mock.calls.length).toBe(1);
    await f.handoff.refresh();
    expect(blocked && destroyed && !published).toBe(true);
  });

  it('retracts and starts disposal synchronously without waiting for a stuck commit', async () => {
    const f = fixture(), entered = deferred<void>(), wait = deferred<void>();
    f.commit.mockImplementationOnce(() => { entered.resolve(); return wait.promise; });
    const pending = f.settle();
    await entered.promise;
    f.revocation.abort();
    expect(f.retract.mock.calls.length > 0).toBe(true);
    expect(f.discard.mock.calls.length).toBe(1);
    expect(f.handoff.view().handoff).toBe('isolated_login_retained');
    wait.resolve();
    expect((await pending).handoff).toBe('isolated_login_retained');
    expect(f.confirm.mock.calls.length).toBe(0);
    expect(f.discard.mock.calls.length).toBe(1);
  });

  it('confirms in the final synchronous stack and does not retract a normal completed handoff', async () => {
    const f = fixture();
    expect((await f.settle()).handoff).toBe('handed_back');
    expect(f.confirm.mock.calls.length).toBe(1);
    f.revocation.abort(); f.handoff.invalidate();
    await f.handoff.refresh();
    expect(f.handoff.view().handoff).toBe('handed_back');
    expect(f.retract.mock.calls.length).toBe(0);
    expect(f.discard.mock.calls.length).toBe(0);
  });

  it('does not revive via reentrant guards, concurrent refresh, duplicate settles or finally', async () => {
    const f = fixture();
    f.host.assertCurrent.mockImplementation(() => f.handoff.invalidate());
    await Promise.all([f.settle(), f.handoff.refresh(), f.settle()]);
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.handoff.view().handoff).toBe('isolated_login_retained');
  });

  it('one completion causes one handoff under concurrent refresh and identical receipts', async () => {
    const f = fixture();
    await Promise.all([f.settle(), f.handoff.refresh(), f.settle(), f.handoff.requestContinue(f.person)]);
    expect(f.commit).toHaveBeenCalledOnce();
  });

  it('latches destination preparation/commit failures and never retries the handoff', async () => {
    for (const stage of ['prepare', 'commit'] as const) {
      const f = fixture();
      if (stage === 'prepare') f.host.prepareHandoff.mockRejectedValueOnce(new Error(randomUUID()));
      else f.commit.mockImplementationOnce(() => { throw new Error(randomUUID()); });
      expect((await f.settle()).reason).toBe('handoff_unconfirmed');
      await f.handoff.refresh();
      await f.handoff.requestContinue(f.person);
      expect(f.host.prepareHandoff).toHaveBeenCalledOnce();
    }
  });

  it('rejects a cloned proof, replaced receipt ids and a proof issued for another outcome', async () => {
    for (const change of ['proof', 'eventId', 'recordId', 'outcome'] as const) {
      const f = fixture(), issued = f.settlement.audit;
      if (issued.status !== 'recorded') throw new Error('fixture_unavailable');
      const receipt = { ...issued, ...(change === 'proof' ? { proof: { ...issued.proof } } : {}),
        ...(change === 'eventId' ? { eventId: randomUUID() } : {}), ...(change === 'recordId' ? { recordId: randomUUID() } : {}) };
      const view = await f.settle({ ...f.settlement, audit: receipt,
        ...(change === 'outcome' ? { outcome: 'login_confirmed' } : {}) });
      expect(view.reason).toBe('audit_unavailable');
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.surface.destroy).toHaveBeenCalledOnce();
    }
  });

  it('rejects a previous person-interaction proof for the completed outcome', async () => {
    const f = fixture(), receipt = f.issue('person_interaction_required');
    f.audit.appendOutcome.mockResolvedValueOnce(receipt);
    const view = await f.settle({ ...f.settlement, outcome: 'person_interaction_required', audit: receipt });
    expect(view.reason).toBe('audit_unavailable');
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('invalidates during fresh outcome persistence and refuses its late success', async () => {
    const f = fixture(), wait = deferred<PostUseAuditResult>(), entered = deferred<void>();
    f.audit.appendOutcome.mockImplementationOnce(() => { entered.resolve(); return wait.promise; });
    const pending = f.settle({ ...f.settlement, outcome: 'person_interaction_required', audit: f.issue('person_interaction_required') });
    await entered.promise;
    f.handoff.invalidate();
    wait.resolve(f.issue());
    expect((await pending).handoff).toBe('isolated_login_retained');
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('starts emergency destruction before an outstanding completion read settles', async () => {
    const f = fixture(), wait = deferred<CredentialCompletion>(), entered = deferred<void>(), destroyed = deferred<void>();
    f.host.readCompletion.mockImplementationOnce(() => { entered.resolve(); return wait.promise; });
    f.surface.destroy.mockImplementationOnce(async () => { destroyed.resolve(); return { status: 'destroyed' }; });
    const pending = f.settle();
    await entered.promise;
    f.handoff.invalidate();
    const beforeReadSettled = await Promise.race([destroyed.promise.then(() => true), new Promise<boolean>(resolve => setImmediate(() => resolve(false)))]);
    wait.resolve(f.completion);
    await pending;
    expect(beforeReadSettled).toBe(true);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('does not report handback after a successful navigation completes late following invalidation', async () => {
    const f = fixture(), wait = deferred<void>(), entered = deferred<void>();
    f.commit.mockImplementationOnce(() => { entered.resolve(); return wait.promise; });
    const pending = f.settle();
    await entered.promise;
    f.handoff.invalidate();
    wait.resolve();
    expect((await pending).handoff).toBe('isolated_login_retained');
    await f.handoff.refresh();
    expect(f.commit).toHaveBeenCalledOnce();
  });

  it('latches the authority revocation signal even when the original host conditions later look current', async () => {
    const f = fixture();
    f.revocation.abort();
    expect(f.handoff.view().handoff).toBe('isolated_login_retained');
    await f.settle();
    await f.handoff.requestContinue(f.person);
    expect(f.host.prepareHandoff).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('fixed registry rejects guessed-use settlements from unregistered capabilities without perturbing a real use', async () => {
    const f = fixture(), registry = new CredentialHandoffRegistry(() => f.handoff);
    registry.registerUse(f.capability, f.binding, f.revocation.signal);
    const event = { capability: f.capability, binding: f.binding, outcome: f.settlement.outcome,
      effectPossible: true, postUseAudit: f.settlement.audit };
    await expect(registry.settle({ ...event, capability: {} as VaultUseCapability })).rejects.toThrow('credential_settlement_rejected');
    expect(registry.personView(f.binding.useId).handoff).toBe('isolated_login_active');
    expect(f.surface.destroy).not.toHaveBeenCalled();
    await registry.settle(event);
    expect(registry.personView(f.binding.useId).handoff).toBe('handed_back');
    expect(f.commit).toHaveBeenCalledOnce();
  });

  it('fixed registry cannot overwrite a registered use with a second capability', () => {
    const f = fixture(), registry = new CredentialHandoffRegistry(() => f.handoff);
    registry.registerUse(f.capability, f.binding, f.revocation.signal);
    expect(() => registry.registerUse({} as VaultUseCapability, f.binding, new AbortController().signal)).toThrow('credential_use_already_registered');
    expect(f.handoff.view().handoff).toBe('isolated_login_active');
  });

  it('keeps construction-time host and audit method identities when dependency objects are later replaced', async () => {
    const f = fixture(), originalPrepare = f.host.prepareHandoff, originalDestroy = f.surface.destroy;
    const replacement = vi.fn(async (_binding: CredentialUseBinding): Promise<PreparedCredentialHandoff> => ({ commit: f.commit, discard: f.discard, retract: f.retract, confirm: f.confirm }));
    f.host.prepareHandoff = replacement;
    f.surface.destroy = vi.fn(async (_binding: CredentialUseBinding, _epoch?: string) => ({ status: 'destroyed' as const }));
    await f.settle();
    expect(originalPrepare).toHaveBeenCalledOnce();
    expect(originalDestroy).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    expect(f.surface.destroy).not.toHaveBeenCalled();
    const other = fixture(), receipt = other.issue();
    if (receipt.status !== 'recorded') throw new Error('fixture_unavailable');
    other.audit.matches = vi.fn((_receipt: Extract<PostUseAuditResult, { status: 'recorded' }>, _context: UseOutcomeContext) => true);
    expect((await other.settle({ ...other.settlement, audit: { ...receipt, proof: {} as PostUseAuditProof } })).reason).toBe('audit_unavailable');
    expect(other.commit).not.toHaveBeenCalled();
  });
});
