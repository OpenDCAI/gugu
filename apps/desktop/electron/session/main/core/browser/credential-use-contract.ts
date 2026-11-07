/** Host-only integration contract. No tools, person approval UI or vault are enabled here. */
declare const useCapability: unique symbol;

/** An in-process identity, validated by its issuer. Serialized objects cannot be capabilities. */
export type VaultUseCapability = Readonly<{ [useCapability]: true }>;

export type CredentialUseBinding = Readonly<{
  /** Allocated by the approval authority; never evidence of authority on their own. */
  requestId: string;
  useId: string;
  accountId: string;
  installationId: string;
  agentId: string;
  sessionId: string;
  /** Agent's destination tab, not the private login contents. */
  browserId: string;
  /** Host-issued private surface identity/epoch, never returned to an Agent. */
  loginSurfaceId: string;
  loginSurfaceEpoch: string;
  documentId: string;
  frameId: string;
  /** Includes the reviewed fields, form and submitter destination; never a raw DOM snapshot. */
  formFingerprint: string;
  credentialId: string;
  credentialVersion: string;
  lockEpoch: string;
  /** Canonical exact HTTPS origin, including the effective port. Never a full URL/query. */
  origin: string;
  operation: 'login-submit';
}>;

export type CredentialUseLease = Readonly<{
  signal: AbortSignal;
  /**
   * Synchronously rejects invalidated host identity, version, lock or navigation state.
   * The trusted browser must also validate actual fields/form/frame/origin atomically
   * with EACH fill and submission; an earlier snapshot cannot establish that check.
   */
  assertCurrent(): void;
  /** Atomically claims the only submission. Never release/retry this claim after failure. */
  claimSubmission(): void;
}>;

/** Proof-only cleanup. Neither result authorizes handing a session back to the Agent tab. */
export type CredentialUseCleanup =
  | Readonly<{ status: 'cleaned' }>
  | Readonly<{ status: 'isolated_login_retained' }>;

/** Storage's fixed sink wrapper; audit readiness is not a second approval/submission ledger. */
export type AuditedCredentialUseLease = CredentialUseLease & Readonly<{
  /** New pre-submit receipt after fill, followed by a fresh assertCurrent; old receipts cannot qualify. */
  prepareSubmission(): Promise<void>;
}>;

export type CredentialUseInvalidation = 'lock' | 'edit' | 'delete' | 'revoke' | 'account_changed' | 'shutdown';

export interface CredentialUseAuthority {
  /** The fixed storage adapter claims once; this is never an Agent or arbitrary callback API. */
  claimCredentialSink(capability: VaultUseCapability, binding: CredentialUseBinding): CredentialUseLease;
  /** Revoke synchronously before waiting for cleanup. Unlock never revives an old use. */
  invalidate(accountId: string, reason: CredentialUseInvalidation, credentialId?: string): void;
  /**
   * Clears and proves the isolated login surface, feature-owned plaintext and artifacts; NEVER hands back.
   * Only the coordinator may later return the session to the Agent tab after the matching reliable
   * post-use audit, verified cleanup, a non-uncertain outcome and no fault latch or other holder.
   * Audit failure retains the isolated surface. Caller input, timeout, retry, stale receipt or a
   * late callback cannot authorize handback. Phase B exposes no observation pause/resume lease.
   */
  cleanup(useId: string): Promise<CredentialUseCleanup>;
}

export type CredentialAuditWrite =
  | Readonly<{ status: 'recorded'; recordId: string }>
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{ status: 'uncertain' }>;

export type CredentialLoginOutcome = 'submitted_unconfirmed' | 'login_confirmed' | 'person_interaction_required' | 'failed' | 'uncertain';
export type CredentialHandoffState = 'isolated_login_active' | 'person_interaction_required' | 'handed_back' | 'isolated_login_retained';
export type CredentialHandoffReason = 'isolation_unavailable' | 'cleanup_unconfirmed' | 'audit_unavailable'
  | 'target_invalidated' | 'outcome_uncertain' | 'person_interaction_required' | 'handoff_unconfirmed';

/** Trusted local UI projection, distinct from Agent results and containing no private surface identity. */
export type CredentialLoginPersonView = Readonly<{
  requestId: string;
  useId: string;
  outcome: CredentialLoginOutcome;
  handoff: CredentialHandoffState;
  reason?: CredentialHandoffReason;
  /** Offers only a fresh host re-evaluation; never a submit or direct handback capability. */
  canRequestContinue: boolean;
}>;
