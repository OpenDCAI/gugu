import { randomUUID } from 'node:crypto';
import type { CredentialUseBinding, CredentialUseInvalidation } from './credential-use-contract';
import { assertCredentialWebsite } from './credential-website';

const REQUEST_MS = 5 * 60_000;
const START_MS = 60_000;
const TARGET_KEYS = ['accountId', 'installationId', 'agentId', 'sessionId', 'browserId', 'loginSurfaceId', 'loginSurfaceEpoch', 'documentId', 'frameId',
  'formFingerprint', 'credentialId', 'credentialVersion', 'lockEpoch', 'origin', 'operation'] as const;
type Target = Omit<CredentialUseBinding, 'requestId' | 'useId'>;
export type CredentialApprovalStatus = 'pending' | 'approved' | 'started' | 'submission_claimed'
  | 'rejected' | 'cancelled' | 'expired' | 'invalidated';
declare const approvalClaim: unique symbol;
/** A start claim is NOT a VaultUseCapability. Isolated-login/audit integration must supply that later. */
export type CredentialApprovalClaim = Readonly<{ [approvalClaim]: true }>;
export type CredentialApprovalView = Readonly<{
  requestId: string; useId: string; status: CredentialApprovalStatus; requestExpiresAt: number;
  startBefore?: number; effectPossible: boolean;
}>;
type Entry = {
  binding: CredentialUseBinding; status: CredentialApprovalStatus; requestUntil: number; requestExpiresAt: number;
  startUntil?: number; startBefore?: number; effectPossible: boolean; controller: AbortController;
};
type ApprovalHost = {
  current(binding: CredentialUseBinding): boolean;
  verifyLocalDecision(binding: CredentialUseBinding, evidence: unknown): boolean;
  now?: () => number; wallNow?: () => number; id?: () => string;
};
type StateError = 'request_unavailable' | 'owner_verification_required' | 'guard_unavailable' | 'target_invalidated'
  | 'not_approved' | 'already_consumed' | 'caller_mismatch' | 'approval_expired';
export class CredentialApprovalError extends Error {
  constructor(readonly code: StateError) { super(code); }
}

/**
 * Host-only, memory-only approval transitions. No tool/UI registration, password, sink or session handback.
 * Its two guards must be constructed from trusted host adapters, never from tool arguments or claimed confirmation.
 * Expiry is checked before every transition using a monotonic clock; wall-clock changes cannot extend approval.
 */
export class CredentialApprovalState {
  private readonly entries = new Map<string, Entry>();
  private readonly operations = new Map<string, string>();
  private readonly useIds = new Set<string>();
  private readonly claims = new WeakMap<object, Entry>();
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly id: () => string;
  private readonly host: Readonly<Pick<ApprovalHost, 'current' | 'verifyLocalDecision'>>;

  constructor(host: ApprovalHost) {
    // Capture method identities, rather than retaining a caller-mutable dependency object.
    this.host = Object.freeze({ current: host.current.bind(host), verifyLocalDecision: host.verifyLocalDecision.bind(host) });
    this.now = host.now?.bind(host) ?? (() => performance.now());
    this.wallNow = host.wallNow?.bind(host) ?? Date.now;
    this.id = host.id?.bind(host) ?? randomUUID;
  }

  request(target: Target, operationId: string): CredentialApprovalView {
    if (!operationId || TARGET_KEYS.some(key => typeof target[key] !== 'string' || !target[key])) {
      throw new CredentialApprovalError('request_unavailable');
    }
    assertCredentialWebsite(target.origin, target.origin);
    if (target.operation !== 'login-submit') throw new CredentialApprovalError('request_unavailable');
    const key = JSON.stringify([target.accountId, target.installationId, target.agentId, target.sessionId, operationId]);
    const previous = this.operations.get(key);
    if (previous) {
      const entry = this.require(previous);
      if (TARGET_KEYS.some(key => entry.binding[key] !== target[key])
        && ['pending', 'approved', 'started', 'submission_claimed'].includes(entry.status)) this.stop(entry, 'invalidated');
      return this.view(entry);
    }
    // Copy only the reviewed fields. Extra properties can never enter the private approval state.
    const binding = Object.freeze({ ...Object.fromEntries(TARGET_KEYS.map(key => [key, target[key]])),
      requestId: this.id(), useId: this.id() }) as CredentialUseBinding;
    if (!binding.requestId || !binding.useId || binding.requestId === binding.useId
      || this.entries.has(binding.requestId) || this.useIds.has(binding.useId)) throw new CredentialApprovalError('request_unavailable');
    const entry: Entry = { binding, status: 'pending', requestUntil: this.now() + REQUEST_MS,
      requestExpiresAt: this.wallNow() + REQUEST_MS, effectPossible: false, controller: new AbortController() };
    this.fresh(entry);
    this.entries.set(binding.requestId, entry);
    this.useIds.add(binding.useId);
    this.operations.set(key, binding.requestId);
    return this.view(entry);
  }

  decide(requestId: string, decision: 'allow_once' | 'reject', evidence: unknown): CredentialApprovalView {
    const entry = this.require(requestId);
    this.expire(entry);
    if (entry.status !== 'pending') return this.view(entry);
    let verified: boolean;
    try { verified = this.host.verifyLocalDecision(entry.binding, evidence); }
    catch { this.stop(entry, 'invalidated'); throw new CredentialApprovalError('guard_unavailable'); }
    if (verified !== true) throw new CredentialApprovalError('owner_verification_required');
    // A verifier may re-enter the host (e.g. lock/revoke); it cannot resurrect that entry.
    this.expire(entry);
    if (entry.status !== 'pending') return this.view(entry);
    this.fresh(entry);
    this.expire(entry);
    if (entry.status !== 'pending') return this.view(entry);
    if (decision === 'reject') this.stop(entry, 'rejected');
    else if (decision === 'allow_once') {
      entry.status = 'approved'; entry.startUntil = this.now() + START_MS; entry.startBefore = this.wallNow() + START_MS;
    } else throw new CredentialApprovalError('request_unavailable');
    return this.view(entry);
  }

  /** Closing a card only affects its presentation, never approval or the private request. */
  close(requestId: string): CredentialApprovalView { return this.view(this.require(requestId)); }
  status(requestId: string): CredentialApprovalView { return this.view(this.require(requestId)); }

  claimStart(requestId: string, current: CredentialUseBinding): {
    claim: CredentialApprovalClaim; binding: CredentialUseBinding; signal: AbortSignal;
  } {
    const entry = this.require(requestId);
    this.expire(entry);
    if (entry.status === 'expired') throw new CredentialApprovalError('approval_expired');
    if (entry.status !== 'approved') throw new CredentialApprovalError('not_approved');
    this.same(entry, current); this.fresh(entry);
    const status = this.view(entry).status;
    if (status === 'expired') throw new CredentialApprovalError('approval_expired');
    if (status !== 'approved') throw new CredentialApprovalError('not_approved');
    entry.status = 'started';
    const claim = Object.freeze({}) as CredentialApprovalClaim;
    this.claims.set(claim, entry);
    return { claim, binding: entry.binding, signal: entry.controller.signal };
  }

  assertStarted(claim: CredentialApprovalClaim, current: CredentialUseBinding): void {
    const entry = this.claimEntry(claim);
    if (entry.status !== 'started' && entry.status !== 'submission_claimed') throw new CredentialApprovalError('target_invalidated');
    this.same(entry, current); this.fresh(entry);
  }

  /** Reserve BEFORE a possible submission; failures never roll back this reservation. */
  claimSubmission(claim: CredentialApprovalClaim, current: CredentialUseBinding): void {
    const entry = this.claimEntry(claim);
    if (entry.effectPossible) throw new CredentialApprovalError('already_consumed');
    this.assertStarted(claim, current);
    if (entry.effectPossible || entry.status !== 'started') throw new CredentialApprovalError('already_consumed');
    entry.status = 'submission_claimed'; entry.effectPossible = true;
  }

  cancel(requestId: string, actor: Pick<Target, 'accountId' | 'installationId' | 'agentId' | 'sessionId'>): CredentialApprovalView {
    const entry = this.require(requestId);
    if (['accountId', 'installationId', 'agentId', 'sessionId'].some(key => entry.binding[key as keyof Target] !== actor[key as keyof typeof actor])) {
      throw new CredentialApprovalError('caller_mismatch');
    }
    this.expire(entry);
    if (['pending', 'approved', 'started', 'submission_claimed'].includes(entry.status)) this.stop(entry, 'cancelled');
    return this.view(entry);
  }

  invalidate(accountId: string, _reason: CredentialUseInvalidation, credentialId?: string): void {
    for (const entry of this.entries.values()) if (entry.binding.accountId === accountId
      && (!credentialId || entry.binding.credentialId === credentialId)
      && ['pending', 'approved', 'started', 'submission_claimed'].includes(entry.status)) this.stop(entry, 'invalidated');
  }

  private claimEntry(claim: CredentialApprovalClaim): Entry {
    const entry = claim && typeof claim === 'object' ? this.claims.get(claim) : undefined;
    if (!entry) throw new CredentialApprovalError('request_unavailable');
    return entry;
  }
  private require(requestId: string): Entry {
    const entry = this.entries.get(requestId);
    if (!entry) throw new CredentialApprovalError('request_unavailable');
    return entry;
  }
  private expire(entry: Entry): void {
    if (entry.status === 'pending' && this.now() >= entry.requestUntil
      || entry.status === 'approved' && this.now() >= entry.startUntil!) this.stop(entry, 'expired');
  }
  private same(entry: Entry, current: CredentialUseBinding): void {
    if (['requestId', 'useId', ...TARGET_KEYS].some(key => entry.binding[key as keyof CredentialUseBinding] !== current[key as keyof CredentialUseBinding])) {
      this.stop(entry, 'invalidated'); throw new CredentialApprovalError('target_invalidated');
    }
  }
  private fresh(entry: Entry): void {
    let current: boolean;
    try { current = this.host.current(entry.binding); }
    catch { this.stop(entry, 'invalidated'); throw new CredentialApprovalError('guard_unavailable'); }
    if (current !== true || entry.controller.signal.aborted) {
      this.stop(entry, 'invalidated'); throw new CredentialApprovalError('target_invalidated');
    }
  }
  private stop(entry: Entry, status: CredentialApprovalStatus): void {
    entry.status = status; entry.controller.abort(new CredentialApprovalError('target_invalidated'));
  }
  private view(entry: Entry): CredentialApprovalView {
    this.expire(entry);
    return Object.freeze({ requestId: entry.binding.requestId, useId: entry.binding.useId, status: entry.status,
      requestExpiresAt: entry.requestExpiresAt, ...(entry.startBefore !== undefined ? { startBefore: entry.startBefore } : {}), effectPossible: entry.effectPossible });
  }
}
