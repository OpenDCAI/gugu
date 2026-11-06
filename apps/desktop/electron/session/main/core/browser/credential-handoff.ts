import type {
  CredentialHandoffReason, CredentialLoginOutcome, CredentialLoginPersonView,
  CredentialUseBinding, VaultUseCapability,
} from './credential-use-contract';
import { CredentialCleanup, type CredentialArtifactCleanup, type CredentialCleanupSurface } from './credential-cleanup';
import type { CredentialCleanupReport, FixedOutcomeAuditPort, PostUseAuditResult, UseOutcomeContext } from './credential-settlement-contract';
import { assertCredentialWebsite } from './credential-website';

const BINDING_KEYS = ['requestId', 'useId', 'accountId', 'installationId', 'agentId', 'sessionId', 'browserId',
  'loginSurfaceId', 'loginSurfaceEpoch', 'documentId', 'frameId', 'formFingerprint', 'credentialId',
  'credentialVersion', 'lockEpoch', 'origin', 'operation'] as const;

export type CredentialCompletion = Readonly<{
  loginSurfaceId: string;
  loginSurfaceEpoch: string;
  surfaceEpoch: string;
  documentId: string;
  documentEpoch: string;
  topDocumentChanged: boolean;
  filledPasswordFieldsAbsent: boolean;
  requiresPersonInteraction: boolean;
}>;

/** Supplied only by the fixed storage sink after clearing its secret buffers and reliable post-use I/O.
 * The receipt is not accepted from a tool, a serialized object or the public useCredential result.
 */
export type CredentialUseSettlement = Readonly<{
  outcome: CredentialLoginOutcome | 'unavailable';
  effectPossible: boolean;
  audit: PostUseAuditResult;
}>;
export interface PreparedCredentialHandoff {
  commit(): Promise<void>;
  /** Dispose only feature-owned unpublished/failed preparation; never restore observation here. */
  discard(): Promise<void>;
}

export interface CredentialHandoffHost {
  /** Actor/ref/lock/surface and destination ownership, including after normal post-submit navigation.
   * Do not reuse the pre-fill document guard or treat an intentional retired surface as an invalid actor.
   */
  assertCurrent(binding: CredentialUseBinding): void;
  readCompletion(binding: CredentialUseBinding): Promise<CredentialCompletion>;
  verifyLocalContinue(binding: CredentialUseBinding, evidence: unknown): boolean;
  /** Must retain destination isolation during preparation. commit is synchronous and starts the
   * safe origin navigation without another await; never adopts the private contents or raw login URL.
   */
  prepareHandoff(binding: CredentialUseBinding): Promise<PreparedCredentialHandoff>;
}

/** Host-only lifecycle for one already-approved use. No approval or submission counter is maintained here.
 * Construction and settle are fixed main-process wiring, never registered as IPC/MCP/person actions.
 */
export class CredentialHandoff {
  private readonly binding: CredentialUseBinding;
  private readonly cleanupState: CredentialCleanup;
  private tail: Promise<unknown> = Promise.resolve();
  private settlement: CredentialUseSettlement | undefined;
  private completion: CredentialCompletion | undefined;
  private fault: CredentialHandoffReason | undefined;
  private handedBack = false;
  private waitingForPerson = false;
  private waitingReason: 'person_interaction_required' | 'handoff_unconfirmed' = 'handoff_unconfirmed';
  private outcome: CredentialLoginOutcome = 'submitted_unconfirmed';
  private useFinished = false;
  private outcomeAudit: PostUseAuditResult | undefined;
  private readonly revoked = () => this.invalidate();
  private readonly host: CredentialHandoffHost;
  private readonly audit: FixedOutcomeAuditPort;

  constructor(binding: CredentialUseBinding, private readonly capability: VaultUseCapability,
    host: CredentialHandoffHost, surface: CredentialCleanupSurface, artifacts: CredentialArtifactCleanup,
    audit: FixedOutcomeAuditPort, private readonly revokedSignal: AbortSignal) {
    assertCredentialWebsite(binding.origin, binding.origin);
    this.host = Object.freeze({ assertCurrent: host.assertCurrent.bind(host), readCompletion: host.readCompletion.bind(host),
      verifyLocalContinue: host.verifyLocalContinue.bind(host), prepareHandoff: host.prepareHandoff.bind(host) });
    this.audit = Object.freeze({ appendOutcome: audit.appendOutcome.bind(audit), matches: audit.matches.bind(audit) });
    this.binding = Object.freeze(Object.fromEntries(BINDING_KEYS.map(key => [key, binding[key]]))) as CredentialUseBinding;
    this.cleanupState = new CredentialCleanup(this.binding, surface, artifacts);
    if (revokedSignal.aborted) this.invalidate();
    else revokedSignal.addEventListener('abort', this.revoked, { once: true });
  }

  view(): CredentialLoginPersonView {
    return Object.freeze({ requestId: this.binding.requestId, useId: this.binding.useId, outcome: this.outcome,
      handoff: this.handedBack ? 'handed_back' : this.fault ? 'isolated_login_retained'
        : this.waitingForPerson ? 'person_interaction_required' : 'isolated_login_active',
      ...(this.fault ? { reason: this.fault } : this.waitingForPerson ? { reason: this.waitingReason } : {}),
      canRequestContinue: this.waitingForPerson && !this.fault && !this.handedBack });
  }

  /** Called synchronously for lock/revoke/cancel/timeout/ownership changes, before any awaited cleanup. */
  invalidate(reason: CredentialHandoffReason = 'target_invalidated'): void {
    if (!this.handedBack) {
      this.latch(reason);
      this.useFinished = true;
    }
  }

  /** Cleanup-only Authority bridge. Missing post-use receipt cannot be inferred from this result. */
  cleanup(useId: string): Promise<CredentialCleanupReport> {
    if (useId !== this.binding.useId) return Promise.resolve({ status: 'isolated_login_retained', disposition: 'fault', reason: 'target_invalidated' });
    this.useFinished = true;
    return this.queue(async () => {
      await this.cleanForState();
      return this.cleanupState.confirmed ? { status: 'cleaned' } : this.fault
        ? { status: 'isolated_login_retained', disposition: 'fault', reason: this.fault }
        : { status: 'isolated_login_retained', disposition: 'awaiting_person', reason: this.waitingReason };
    });
  }

  /** Private fixed-sink notification. Identity is checked by object reference and complete captured binding.
   * A late recorded receipt cannot remove any previously latched failure.
   */
  settle(capability: VaultUseCapability, binding: CredentialUseBinding, value: CredentialUseSettlement): Promise<CredentialLoginPersonView> {
    if (capability !== this.capability || !this.same(binding)) return Promise.reject(new Error('credential_settlement_rejected'));
    if (!value || !['submitted_unconfirmed', 'login_confirmed', 'person_interaction_required', 'failed', 'uncertain', 'unavailable'].includes(value.outcome)
      || typeof value.effectPossible !== 'boolean' || !value.audit
      || !['recorded', 'unavailable', 'uncertain', 'not_attempted'].includes(value.audit.status)) {
      this.useFinished = true;
      this.latch('audit_unavailable');
      return this.refresh();
    }
    const next = Object.freeze({ outcome: value.outcome, effectPossible: value.effectPossible,
      audit: this.copyAudit(value.audit) });
    this.useFinished = true;
    if (!this.settlement) {
      this.settlement = next;
      this.outcome = next.outcome === 'unavailable' ? 'failed' : next.outcome;
      this.outcomeAudit = next.audit;
      if (!this.auditMatches(next.audit, next.outcome)) this.latch('audit_unavailable');
      if (next.outcome === 'uncertain') this.latch('outcome_uncertain');
      if (next.outcome === 'failed' || next.outcome === 'unavailable') this.latch('target_invalidated');
      if (next.effectPossible !== true) this.latch('target_invalidated');
    } else if (!this.sameSettlement(this.settlement, next)) this.latch('audit_unavailable');
    return this.refresh();
  }

  /** Host navigation/completion event. Caller supplies no claimed completion or cleanup flags. */
  refresh(): Promise<CredentialLoginPersonView> { return this.queue(() => this.evaluate(false)); }

  /** The person action only requests a fresh evaluation. It cannot submit again or supply a receipt. */
  requestContinue(evidence: unknown): Promise<CredentialLoginPersonView> {
    let verified = false;
    try { verified = this.host.verifyLocalContinue(this.binding, evidence) === true; } catch { this.latch('target_invalidated'); }
    if (!verified) return Promise.reject(new Error('local_person_required'));
    return this.queue(() => this.evaluate(true));
  }

  private async evaluate(personVerified: boolean): Promise<CredentialLoginPersonView> {
    if (this.handedBack) return this.view();
    await this.cleanForState(personVerified);
    if (this.fault || !this.settlement || !this.cleanupState.confirmed || !this.completion) return this.view();
    // A completed person step is a new outcome. Its earlier awaiting-person proof cannot certify it.
    if (this.outcome === 'person_interaction_required') {
      const outcome = 'submitted_unconfirmed' as const;
      let receipt: PostUseAuditResult;
      try { receipt = await this.audit.appendOutcome(this.context(outcome)); }
      catch { this.latch('audit_unavailable'); return this.view(); }
      if (!this.current() || !this.auditMatches(receipt, outcome)) {
        this.latch('audit_unavailable'); return this.view();
      }
      this.outcome = outcome;
      this.outcomeAudit = this.copyAudit(receipt);
    }
    let prepared: PreparedCredentialHandoff;
    try { prepared = await this.host.prepareHandoff(this.binding); }
    catch { this.latch('handoff_unconfirmed'); return this.view(); }
    try {
      // Do not move this check before the await. Invalidations while preparing must win.
      if (!this.current() || !this.outcomeAudit || !this.auditMatches(this.outcomeAudit, this.outcome) || this.fault) return this.view();
      try { await prepared.commit(); }
      catch { this.latch('handoff_unconfirmed'); return this.view(); }
      // A late successful load, or a synchronous callback during dispatch, cannot revive an invalidated use.
      if (this.current() && !this.fault && this.auditMatches(this.outcomeAudit, this.outcome)) {
        this.handedBack = true;
        this.revokedSignal.removeEventListener('abort', this.revoked);
      }
    } finally {
      if (!this.handedBack) {
        try { await prepared.discard(); } catch { this.latch('cleanup_unconfirmed'); }
      }
    }
    return this.view();
  }

  private async cleanForState(personVerified = false): Promise<void> {
    if (this.handedBack || !this.useFinished) return;
    if (!this.current()) this.latch('target_invalidated');
    if (!this.fault && !this.cleanupState.destroyed) {
      try {
        const read = await this.host.readCompletion(this.binding);
        const completed = Object.freeze({ loginSurfaceId: read.loginSurfaceId, loginSurfaceEpoch: read.loginSurfaceEpoch,
          surfaceEpoch: read.surfaceEpoch, documentId: read.documentId, documentEpoch: read.documentEpoch,
          topDocumentChanged: read.topDocumentChanged, filledPasswordFieldsAbsent: read.filledPasswordFieldsAbsent,
          requiresPersonInteraction: read.requiresPersonInteraction });
        if (!this.current()) this.latch('target_invalidated');
        else if (completed.loginSurfaceId !== this.binding.loginSurfaceId || completed.loginSurfaceEpoch !== this.binding.loginSurfaceEpoch
          || completed.surfaceEpoch !== this.binding.loginSurfaceEpoch || !completed.documentEpoch || !completed.documentId
          || (completed.topDocumentChanged && completed.documentId === this.binding.documentId)) this.latch('target_invalidated');
        else if (completed.filledPasswordFieldsAbsent === true && completed.requiresPersonInteraction === false
          && (completed.topDocumentChanged === true || personVerified)) {
          this.completion = completed;
          this.waitingForPerson = false;
        } else {
          this.waitingForPerson = true;
          this.waitingReason = completed.requiresPersonInteraction === true ? 'person_interaction_required' : 'handoff_unconfirmed';
        }
      } catch { this.latch('cleanup_unconfirmed'); }
    }
    // Failure cleanup still runs without an audit receipt and cannot be skipped by invalidation.
    await this.cleanupState.run(Boolean(this.fault || this.completion), this.fault ? undefined : this.completion?.documentEpoch);
    if (this.cleanupState.failed) this.latch('cleanup_unconfirmed');
  }

  private current(): boolean {
    if (this.fault) return false;
    if (this.revokedSignal.aborted) { this.latch('target_invalidated'); return false; }
    try { this.host.assertCurrent(this.binding); return !this.fault; }
    catch { this.latch('target_invalidated'); return false; }
  }
  private latch(reason: CredentialHandoffReason): void {
    if (!this.fault) {
      this.fault = reason;
      this.revokedSignal.removeEventListener('abort', this.revoked);
      // Do not queue this behind readCompletion or handoff I/O: either may never settle.
      void this.cleanupState.retire().then(() => this.cleanupState.run(true)).catch(() => {
        // The original fault remains latched; raw cleanup errors never leave this private boundary.
      });
    }
    this.waitingForPerson = false;
  }
  private same(binding: CredentialUseBinding): boolean {
    return Boolean(binding && BINDING_KEYS.every(key => binding[key] === this.binding[key]));
  }
  private sameSettlement(left: CredentialUseSettlement, right: CredentialUseSettlement): boolean {
    return left.outcome === right.outcome && left.effectPossible === right.effectPossible
      && left.audit.status === right.audit.status && (left.audit.status !== 'recorded'
        || (right.audit.status === 'recorded' && left.audit.recordId === right.audit.recordId
          && left.audit.eventId === right.audit.eventId && left.audit.proof === right.audit.proof));
  }
  private context(outcome: CredentialUseSettlement['outcome']): UseOutcomeContext {
    return Object.freeze({ capability: this.capability, binding: this.binding, outcome,
      effectPossible: this.settlement?.effectPossible === true });
  }
  private copyAudit(receipt: PostUseAuditResult): PostUseAuditResult {
    return receipt.status === 'recorded' ? Object.freeze({ status: receipt.status, eventId: receipt.eventId,
      recordId: receipt.recordId, proof: receipt.proof }) : Object.freeze({ status: receipt.status });
  }
  private auditMatches(receipt: PostUseAuditResult, outcome: CredentialUseSettlement['outcome']): boolean {
    try {
      if (receipt.status === 'recorded' && receipt.eventId && receipt.recordId
        && this.audit.matches(receipt, this.context(outcome)) === true && !this.fault) return true;
    } catch { /* An issuer failure cannot be replaced by a record id. */ }
    this.latch('audit_unavailable');
    return false;
  }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
}
