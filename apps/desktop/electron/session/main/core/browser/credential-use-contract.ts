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
  browserId: string;
  documentId: string;
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

/** Both results retain the observation pause. Cleanup never authorizes observation to resume. */
export type CredentialUseCleanup =
  | Readonly<{ status: 'cleaned' }>
  | Readonly<{ status: 'paused_cleanup_unconfirmed' }>;

export type CredentialUseInvalidation = 'lock' | 'edit' | 'delete' | 'revoke' | 'account_changed' | 'shutdown';

export interface CredentialUseAuthority {
  /** The fixed storage adapter claims once; this is never an Agent or arbitrary callback API. */
  claimCredentialSink(capability: VaultUseCapability, binding: CredentialUseBinding): CredentialUseLease;
  /** Revoke synchronously before waiting for cleanup. Unlock never revives an old use. */
  invalidate(accountId: string, reason: CredentialUseInvalidation, credentialId?: string): void;
  /**
   * Clears and proves inputs, feature-owned plaintext and artifacts; NEVER resumes observation.
   * Only the coordinator may later release its private observation lease, after reliable
   * post-use audit and a non-uncertain outcome. Audit failure permanently holds that use.
   * A caller, timeout, retry or cleaned result cannot authorize release.
   */
  cleanup(useId: string): Promise<CredentialUseCleanup>;
}

export type CredentialAuditWrite =
  | Readonly<{ status: 'recorded'; recordId: string }>
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{ status: 'uncertain' }>;
