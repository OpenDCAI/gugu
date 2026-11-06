import { describe, expect, it, vi } from 'vitest';
import { CredentialApprovalState, type CredentialApprovalClaim } from './credential-approval-state';
import type { CredentialUseBinding } from './credential-use-contract';

const target = { accountId: 'owner', installationId: 'install', agentId: 'agent', sessionId: 'session', browserId: 'tab',
  loginSurfaceId: 'private-login', loginSurfaceEpoch: 'private-epoch', documentId: 'document', frameId: 'top-frame',
  formFingerprint: 'form', credentialId: 'credential', credentialVersion: '7', lockEpoch: 'epoch',
  origin: 'https://example.test', operation: 'login-submit' as const };

function fixture() {
  let monotonic = 0, wall = 10_000, id = 0, current = true;
  const person = Object.freeze({});
  const verify = vi.fn((_binding: CredentialUseBinding, evidence: unknown) => evidence === person);
  const guard = vi.fn(() => current);
  const state = new CredentialApprovalState({ current: guard, verifyLocalDecision: verify,
    now: () => monotonic, wallNow: () => wall, id: () => String(++id) });
  const request = state.request(target, 'operation');
  const binding = { ...target, requestId: request.requestId, useId: request.useId };
  return { state, person, verify, guard, request, binding, advance: (ms: number) => { monotonic += ms; wall += ms; },
    wall: (value: number) => { wall = value; }, current: (value: boolean) => { current = value; },
    approve: () => state.decide(request.requestId, 'allow_once', person),
    start: () => state.claimStart(request.requestId, binding) };
}

describe('memory-only credential approval state', () => {
  it('captures the local decision verifier and target guard at construction', () => {
    let current = true;
    const host = { current: () => current, verifyLocalDecision: (_binding: CredentialUseBinding, evidence: unknown) => evidence === 'local' };
    const state = new CredentialApprovalState(host), request = state.request(target, 'operation');
    host.verifyLocalDecision = () => true;
    expect(() => state.decide(request.requestId, 'allow_once', 'claimed-confirmation')).toThrow('owner_verification_required');
    host.current = () => true; current = false;
    expect(() => state.decide(request.requestId, 'allow_once', 'local')).toThrow('target_invalidated');
  });
  it('does not interpret closing a card, full access or claimed confirmation as approval', () => {
    const f = fixture();
    expect(f.state.close(f.request.requestId).status).toBe('pending');
    for (const evidence of [true, 'confirmed', { confirmed: true }, { fullAccess: true }, { optionId: 'allow_once' }]) {
      expect(() => f.state.decide(f.request.requestId, 'allow_once', evidence)).toThrow('owner_verification_required');
    }
    expect(() => f.start()).toThrow('not_approved');
  });
  it('expires a pending request at five minutes, including duplicate operation retries', () => {
    const f = fixture(); f.advance(300_000);
    expect(f.state.status(f.request.requestId).status).toBe('expired');
    expect(f.state.request(target, 'operation').requestId).toBe(f.request.requestId);
    expect(f.approve().status).toBe('expired');
    expect(() => f.start()).toThrow('approval_expired');
  });
  it('expires approved but unstarted use at sixty seconds', () => {
    const f = fixture(); f.approve(); f.advance(60_000);
    expect(() => f.start()).toThrow('approval_expired');
  });
  it('gives an approval made near the pending deadline its own sixty-second start window', () => {
    const f = fixture(); f.advance(299_999); f.approve(); f.advance(59_999);
    expect(f.start().signal.aborted).toBe(false);
  });
  it('cannot extend a deadline by rolling the wall clock backwards', () => {
    const f = fixture(); f.approve(); f.wall(-1_000_000); f.advance(60_000);
    expect(() => f.start()).toThrow('approval_expired');
  });
  it('settles rejection once and never creates a replacement request for the same operation', () => {
    const f = fixture();
    expect(f.state.decide(f.request.requestId, 'reject', f.person).status).toBe('rejected');
    expect(f.approve().status).toBe('rejected');
    expect(f.state.request(target, 'operation').status).toBe('rejected');
    expect(() => f.start()).toThrow('not_approved');
  });
  it('invalidates an operation retry whose actual target changed instead of reusing its approval', () => {
    const f = fixture(); f.approve();
    expect(f.state.request({ ...target, browserId: 'other-tab' }, 'operation')).toMatchObject({
      requestId: f.request.requestId, status: 'invalidated', effectPossible: false,
    });
  });
  it('rechecks deadlines after a slow synchronous host guard', () => {
    const f = fixture();
    f.guard.mockImplementationOnce(() => { f.advance(300_000); return true; });
    expect(f.approve().status).toBe('expired');
    const started = fixture(); started.approve();
    started.guard.mockImplementationOnce(() => { started.advance(60_000); return true; });
    expect(() => started.start()).toThrow('approval_expired');
  });
  it('claims one start and one possible submission, even after a caller reports failure', () => {
    const f = fixture(); f.approve(); const { claim } = f.start();
    expect(() => f.start()).toThrow('not_approved');
    f.state.claimSubmission(claim, f.binding);
    expect(f.state.status(f.request.requestId).effectPossible).toBe(true);
    expect(() => f.state.claimSubmission(claim, f.binding)).toThrow('already_consumed');
  });
  it.each(['accountId', 'installationId', 'agentId', 'sessionId', 'browserId', 'loginSurfaceId', 'loginSurfaceEpoch', 'documentId', 'frameId', 'formFingerprint',
    'credentialId', 'credentialVersion', 'lockEpoch', 'origin', 'requestId', 'useId'] as const)('invalidates on changed %s before starting', key => {
    const f = fixture(); f.approve();
    expect(() => f.state.claimStart(f.request.requestId, { ...f.binding, [key]: 'changed' })).toThrow('target_invalidated');
    expect(f.state.status(f.request.requestId).status).toBe('invalidated');
  });
  it('checks a changed form again before submission, invalidating the already started use', () => {
    const f = fixture(); f.approve(); const { claim, signal } = f.start();
    expect(() => f.state.claimSubmission(claim, { ...f.binding, formFingerprint: 'other' })).toThrow('target_invalidated');
    expect(signal.aborted).toBe(true);
    expect(f.state.status(f.request.requestId).effectPossible).toBe(false);
  });
  it('does not accept a cloned or serialized claim or one from a prior process state', () => {
    const f = fixture(); f.approve(); const { claim } = f.start();
    expect(() => f.state.claimSubmission({ ...claim }, f.binding)).toThrow('request_unavailable');
    expect(() => f.state.claimSubmission(JSON.parse(JSON.stringify(claim)) as CredentialApprovalClaim, f.binding)).toThrow('request_unavailable');
    const restarted = new CredentialApprovalState({ current: () => true, verifyLocalDecision: () => false });
    expect(() => restarted.claimSubmission(claim, f.binding)).toThrow('request_unavailable');
    expect(() => restarted.status(f.request.requestId)).toThrow('request_unavailable');
  });
  it('aborts lock/revoke/edit/delete and cannot revive approval after the guard becomes valid', () => {
    for (const reason of ['lock', 'revoke', 'edit', 'delete', 'account_changed', 'shutdown'] as const) {
      const f = fixture(); f.approve(); const { claim, signal } = f.start();
      f.state.invalidate(target.accountId, reason, target.credentialId);
      expect(signal.aborted).toBe(true);
      expect(() => f.state.assertStarted(claim, f.binding)).toThrow('target_invalidated');
      f.current(true);
      expect(f.approve().status).toBe('invalidated');
    }
  });
  it('preserves possible side effects when cancel/lock arrives after the submission reservation', () => {
    const f = fixture(); f.approve(); const { claim } = f.start(); f.state.claimSubmission(claim, f.binding);
    expect(f.state.cancel(f.request.requestId, target)).toMatchObject({ status: 'cancelled', effectPossible: true });
    expect(() => f.state.claimSubmission(claim, f.binding)).toThrow('already_consumed');
  });
  it('only lets the same actual actor cancel and treats pre-start cancellation as zero possible effect', () => {
    const f = fixture();
    expect(() => f.state.cancel(f.request.requestId, { ...target, sessionId: 'other' })).toThrow('caller_mismatch');
    expect(f.state.cancel(f.request.requestId, target)).toMatchObject({ status: 'cancelled', effectPossible: false });
  });
  it('fails closed if the fresh host guard is false or throws', () => {
    for (const throwing of [false, true]) {
      const f = fixture(); f.approve();
      if (throwing) f.guard.mockImplementation(() => { throw new Error('untrusted lower-layer payload'); });
      else f.current(false);
      expect(() => f.start()).toThrow(throwing ? 'guard_unavailable' : 'target_invalidated');
      expect(f.state.status(f.request.requestId).status).toBe('invalidated');
    }
  });
  it('cannot resurrect a request invalidated during person verification', () => {
    const f = fixture();
    f.verify.mockImplementation(() => { f.state.invalidate(target.accountId, 'lock'); return true; });
    expect(f.approve().status).toBe('invalidated');
  });
  it('does not grant a second start or submission through reentrant host validation', () => {
    const f = fixture(); f.approve(); let inner: ReturnType<typeof f.start> | undefined;
    f.guard.mockImplementationOnce(() => { inner = f.start(); return true; });
    expect(() => f.start()).toThrow('not_approved');
    expect(inner).toBeDefined();
    f.guard.mockImplementationOnce(() => { f.state.claimSubmission(inner!.claim, f.binding); return true; });
    expect(() => f.state.claimSubmission(inner!.claim, f.binding)).toThrow('already_consumed');
    expect(f.state.status(f.request.requestId).effectPossible).toBe(true);
  });
});
