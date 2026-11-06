/**
 * B settlement integration contract v1.1. Host-only, not an MCP/UI payload.
 * Existing v4 capability/claim remains the only approval/submission authority.
 * This file specifies adapters; it does not claim runtime implementation.
 */
import type {
  VaultUseCapability, CredentialUseBinding, CredentialLoginOutcome,
  CredentialHandoffReason, CredentialLoginPersonView,
} from './credential-use-contract';

export type SettledUseOutcome = CredentialLoginOutcome | 'unavailable';

export type UseOutcomeContext = Readonly<{
  capability: VaultUseCapability;
  binding: CredentialUseBinding;
  outcome: SettledUseOutcome;
  effectPossible: boolean;
}>;

declare const postUseAuditProof: unique symbol;
/** Issued only by the fixed storage/audit adapter after reliable persistence. */
export type PostUseAuditProof = Readonly<{ [postUseAuditProof]: true }>;

export type RecordedPostUseAudit = Readonly<{
  status: 'recorded'; eventId: string; recordId: string; proof: PostUseAuditProof;
}>;
export type PostUseAuditResult = RecordedPostUseAudit
  | Readonly<{ status: 'unavailable' | 'uncertain' | 'not_attempted' }>;

/**
 * Constructed once by storage/audit and injected once into the handback coordinator.
 * No caller-selected writer, callback, paths or receipt verifier.
 */
export interface FixedOutcomeAuditPort {
  /** Encrypted audit remains the sole writer; the coordinator requests an actual current outcome event. */
  appendOutcome(context: UseOutcomeContext): Promise<PostUseAuditResult>;
  /**
   * Checks issuer-owned proof identity, the receipt's eventId/recordId AND the complete context.
   * Replacing either ID, cloning/serializing the proof or supplying only a string cannot qualify.
   * Proof metadata is audit readiness, not a second approval/submission ledger.
   */
  matches(recorded: RecordedPostUseAudit, expected: UseOutcomeContext): boolean;
}

/**
 * The handback coordinator owns actual cleanup state. The status projection remains compatible
 * with v4 CredentialUseCleanup; disposition is retained in trusted lifecycle/UI.
 */
export type CredentialCleanupReport =
  | Readonly<{ status: 'cleaned' }>
  | Readonly<{
      status: 'isolated_login_retained';
      disposition: 'awaiting_person';
      reason: 'person_interaction_required' | 'handoff_unconfirmed';
    }>
  | Readonly<{
      status: 'isolated_login_retained';
      disposition: 'fault';
      reason: CredentialHandoffReason;
    }>;

export type CredentialUseSettlement = UseOutcomeContext & Readonly<{
  postUseAudit: PostUseAuditResult;
}>;

/**
 * Fixed on VaultBrowserSink at trusted host construction.
 * Storage invokes it for each actual outcome transition AFTER a successful claim,
 * after clearing Buffers and attempting required cleanup/audit, including failure.
 * A forged/unclaimed capability must trigger neither cleanup nor settlement.
 * It is never supplied per call or reached through tools or the person UI.
 */
export interface FixedVaultUseSettlementSink {
  settle(event: CredentialUseSettlement): Promise<void>;
}

/** Internal shape; the fixed sink adapter maps postUseAudit to audit and drops this private view. */
export interface CredentialHandoffCoordinator {
  settle(capability: VaultUseCapability, binding: CredentialUseBinding,
    result: Readonly<{ outcome: SettledUseOutcome; effectPossible: boolean; audit: PostUseAuditResult }>
  ): Promise<CredentialLoginPersonView>;
}

/**
 * Required runtime rules:
 * - First identify an already-claimed registered use by original capability object identity,
 *   then check the complete binding. Reject an unknown/forged capability without mutating
 *   any use named by caller-controlled strings. Do NOT claim the credential/submission twice.
 * - Cleanup is proven by the coordinator's fixed adapters/state. No outcome/retain flag,
 *   settle field or recordId is accepted as a substitute.
 * - 'recorded' qualifies only with matches(recorded, exactContext) from the injected issuer,
 *   including use/surface id+epoch, outcome and effectPossible.
 * - appendOutcome produces proof only from that exact closure's actual recorded event;
 *   unavailable/uncertain/not_attempted never has proof.
 * - Audit/cleanup/settle errors latch a fault and prohibit handback. A later success,
 *   old receipt, duplicate notification or timeout cannot clear it.
 * - awaiting_person is NOT a fault. It covers actual requiresPersonInteraction OR
 *   insufficient current evidence to decide completion automatically, with
 *   verified field/artifact clearing and retention of the isolated page.
 *   Continue only re-evaluates; it grants no fill/submission.
 * - When person interaction changes the actual outcome, request a fresh appendOutcome and
 *   verify its new proof before handback. A person_interaction_required receipt cannot
 *   certify login_confirmed.
 * - Duplicate notifications with identical proof/event are idempotent; a conflicting/stale
 *   notification cannot advance the lifecycle.
 * - If settle rejects/throws, storage returns a safe retained/unavailable/uncertain result;
 *   it never falls back to a public result as handback permission.
 * - Faulted/invalidated authenticated uses remain retained. Reject unregistered uses
 *   without creating or disturbing another lifecycle. No recovery of an approval or
 *   secret across restart is introduced here.
 */
