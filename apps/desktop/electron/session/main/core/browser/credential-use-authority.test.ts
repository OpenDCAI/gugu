import { describe, expect, it, vi } from 'vitest';
import { CredentialApprovalState } from './credential-approval-state';
import { CredentialUseAuthorityBridge } from './credential-use-authority';
import type { CredentialUseBinding, CredentialUseCleanup, VaultUseCapability } from './credential-use-contract';

function fixture() {
  const target = { accountId: 'owner', installationId: 'installation', agentId: 'agent', sessionId: 'session',
    browserId: 'destination', loginSurfaceId: 'private', loginSurfaceEpoch: 'surface-epoch', documentId: 'document',
    frameId: 'top-frame', formFingerprint: 'form', credentialId: 'credential', credentialVersion: '7', lockEpoch: 'lock-epoch',
    origin: 'https://example.test', operation: 'login-submit' as const };
  let now = 0, next = 0;
  const person = Object.freeze({});
  const current = vi.fn(() => true), isolation = vi.fn((_binding: CredentialUseBinding) => true);
  const approval = new CredentialApprovalState({ current, verifyLocalDecision: (_binding, evidence) => evidence === person,
    now: () => now, id: () => String(++next) });
  const cleanup = vi.fn(async (_binding: CredentialUseBinding): Promise<CredentialUseCleanup> => ({ status: 'cleaned' }));
  const bridge = new CredentialUseAuthorityBridge({ approval, isolationCurrent: isolation, cleanup });
  const request = approval.request(target, 'operation');
  const binding = { ...target, requestId: request.requestId, useId: request.useId };
  return { approval, bridge, binding, request, current, isolation, cleanup,
    advance: (ms: number) => { now += ms; },
    approve: () => approval.decide(request.requestId, 'allow_once', person),
    issue: () => bridge.issue(request.requestId, binding) };
}

describe('host-only bridge to the unique credential approval authority', () => {
  it('cannot issue from claimed confirmation, an unanswered request or an expired approval', () => {
    const f = fixture();
    expect(() => f.issue()).toThrow('not_approved');
    f.approve(); f.advance(60_000);
    expect(() => f.issue()).toThrow('approval_expired');
  });

  it('claims the fixed sink once and reserves the only submission in the original approval state', () => {
    const f = fixture(); f.approve();
    const capability = f.issue(), lease = f.bridge.claimCredentialSink(capability, f.binding);
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.keys(capability)).toEqual([]);
    expect(() => f.bridge.claimCredentialSink(capability, f.binding)).toThrow('capability_unavailable');
    lease.claimSubmission();
    expect(f.approval.status(f.request.requestId)).toMatchObject({ status: 'submission_claimed', effectPossible: true });
    expect(() => lease.claimSubmission()).toThrow('already_consumed');
    expect(() => f.issue()).toThrow('not_approved');
  });

  it.each(['clone', 'serialization', 'new-instance', 'string'])('rejects a %s instead of the issued object identity', kind => {
    const f = fixture(); f.approve(); const capability = f.issue();
    const value = kind === 'clone' ? { ...capability } : kind === 'serialization' ? JSON.parse(JSON.stringify(capability))
      : kind === 'string' ? f.binding.useId : capability;
    const bridge = kind === 'new-instance' ? fixture().bridge : f.bridge;
    expect(() => bridge.claimCredentialSink(value as VaultUseCapability, f.binding)).toThrow('capability_unavailable');
  });

  it.each(['requestId', 'useId', 'accountId', 'installationId', 'agentId', 'sessionId', 'browserId',
    'loginSurfaceId', 'loginSurfaceEpoch', 'documentId', 'frameId', 'formFingerprint', 'credentialId',
    'credentialVersion', 'lockEpoch', 'origin', 'operation'] as const)('consumes a mismatched %s claim without allowing retry', key => {
    const f = fixture(); f.approve(); const capability = f.issue();
    expect(() => f.bridge.claimCredentialSink(capability, { ...f.binding, [key]: 'changed' })).toThrow('binding_mismatch');
    expect(() => f.bridge.claimCredentialSink(capability, f.binding)).toThrow('capability_unavailable');
    expect(f.approval.status(f.request.requestId).effectPossible).toBe(false);
  });

  it('copies the binding before issuing and never uses a later caller mutation', () => {
    const f = fixture(); f.approve(); const original = { ...f.binding }, capability = f.issue();
    f.binding.origin = 'https://other.test';
    const lease = f.bridge.claimCredentialSink(capability, original);
    lease.claimSubmission();
    expect(f.isolation.mock.calls.at(-1)?.[0].origin).toBe(original.origin);
  });

  it.each(['false', 'throw'])('refuses an unavailable isolation guard (%s) before a start', kind => {
    const f = fixture(); f.approve();
    f.isolation.mockImplementation(() => { if (kind === 'throw') throw new Error('private diagnostic'); return false; });
    expect(() => f.issue()).toThrow('isolation_unavailable');
    expect(f.approval.status(f.request.requestId).status).toBe('approved');
  });

  it('latches lost isolation before submission and never revives the lease when the guard recovers', () => {
    const f = fixture(); f.approve(); const lease = f.bridge.claimCredentialSink(f.issue(), f.binding);
    f.isolation.mockReturnValue(false);
    expect(() => lease.claimSubmission()).toThrow('isolation_unavailable');
    expect(lease.signal.aborted).toBe(true);
    f.isolation.mockReturnValue(true);
    expect(() => lease.claimSubmission()).toThrow('capability_unavailable');
    expect(f.approval.status(f.request.requestId).effectPossible).toBe(false);
  });

  it('rejects revocation that re-enters from the isolation guard even if that guard returns true', () => {
    const f = fixture(); f.approve();
    f.isolation.mockImplementationOnce(() => true).mockImplementationOnce(() => {
      f.bridge.invalidate(f.binding.accountId, 'lock'); return true;
    });
    expect(() => f.issue()).toThrow('target_invalidated');
    expect(f.approval.status(f.request.requestId).status).toBe('invalidated');
  });

  it('observes direct approval cancellation and preserves possible submission effects', () => {
    const f = fixture(); f.approve(); const lease = f.bridge.claimCredentialSink(f.issue(), f.binding);
    lease.claimSubmission();
    f.approval.cancel(f.request.requestId, f.binding);
    expect(lease.signal.aborted).toBe(true);
    expect(() => lease.assertCurrent()).toThrow('capability_unavailable');
    expect(f.approval.status(f.request.requestId).effectPossible).toBe(true);
  });

  it('invalidates synchronously before cleanup and never uses cleaned as a handback permission', async () => {
    const f = fixture(); f.approve(); const lease = f.bridge.claimCredentialSink(f.issue(), f.binding);
    let finish!: (value: CredentialUseCleanup) => void;
    f.cleanup.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = f.bridge.cleanup(f.binding.useId), duplicate = f.bridge.cleanup(f.binding.useId);
    expect(lease.signal.aborted).toBe(true);
    expect(first).toBe(duplicate);
    await Promise.resolve();
    expect(f.cleanup).toHaveBeenCalledExactlyOnceWith(f.binding);
    finish({ status: 'cleaned' });
    expect(await first).toEqual({ status: 'cleaned' });
    expect(() => lease.assertCurrent()).toThrow('capability_unavailable');
    expect(f.approval.status(f.request.requestId).effectPossible).toBe(false);
  });

  it('retains cleanup failure without retry or revival, and ignores unknown use strings', async () => {
    const f = fixture();
    expect(await f.bridge.cleanup('tool-supplied-use')).toEqual({ status: 'isolated_login_retained' });
    expect(f.cleanup).not.toHaveBeenCalled();
    f.approve(); const lease = f.bridge.claimCredentialSink(f.issue(), f.binding);
    f.cleanup.mockRejectedValueOnce(new Error('private diagnostic'));
    expect(await f.bridge.cleanup(f.binding.useId)).toEqual({ status: 'isolated_login_retained' });
    expect(await f.bridge.cleanup(f.binding.useId)).toEqual({ status: 'isolated_login_retained' });
    expect(f.cleanup).toHaveBeenCalledOnce();
    expect(lease.signal.aborted).toBe(true);
  });
});
