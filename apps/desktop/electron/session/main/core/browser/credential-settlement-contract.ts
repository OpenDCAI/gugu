/**
 * B settlement integration contract v1. Host-only, not an MCP/UI payload.
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

export type PostUseAuditResult =
  | Readonly<{ status: 'recorded'; eventId: string; recordId: string; proof: PostUseAuditProof }>
  | Readonly<{ status: 'unavailable' | 'uncertain' | 'not_attempted' }>;

/**
 * Constructed once by storage/audit and injected once into the handback coordinator.
 * No caller-selected writer, callback, paths or receipt verifier.
 */
export interface FixedOutcomeAuditPort {
  /** Encrypted audit remains the sole writer; the coordinator requests an actual current outcome event. */
  appendOutcome(context: UseOutcomeContext): Promise<PostUseAuditResult>;
  /**
   * Checks issuer-owned in-process proof identity AND the complete expected context.
   * A cloned/serialized object or recordId string cannot qualify.
   * Proof metadata is audit readiness, not a second approval/submission ledger.
   */
  matches(proof: PostUseAuditProof, expected: UseOutcomeContext): boolean;
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
      reason: 'person_interaction_required';
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
 * Storage invokes it once for each actual outcome transition, after clearing Buffers
 * and attempting required cleanup/audit, including failure paths.
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
 * - Match the original capability by object identity and the complete registered binding;
 *   do NOT claim the credential/submission a second time.
 * - Cleanup is proven by the coordinator's fixed adapters/state. No outcome/retain flag,
 *   settle field or recordId is accepted as a substitute.
 * - 'recorded' qualifies only with matches(proof, exactContext) from the injected issuer,
 *   including use/surface id+epoch, outcome and effectPossible.
 * - appendOutcome produces proof only from that exact closure's actual recorded event;
 *   unavailable/uncertain/not_attempted never has proof.
 * - Audit/cleanup/settle errors latch a fault and prohibit handback. A later success,
 *   old receipt, duplicate notification or timeout cannot clear it.
 * - awaiting_person is NOT a fault. It requires actual requiresPersonInteraction,
 *   verified field/artifact clearing and retention of the isolated page.
 *   Continue only re-evaluates; it grants no fill/submission.
 * - When person interaction changes the actual outcome, request a fresh appendOutcome and
 *   verify its new proof before handback. A person_interaction_required receipt cannot
 *   certify login_confirmed.
 * - Duplicate notifications with identical proof/event are idempotent; a conflicting/stale
 *   notification cannot advance the lifecycle.
 * - If settle rejects/throws, storage returns a safe retained/unavailable/uncertain result;
 *   it never falls back to a public result as handback permission.
 * - Faulted/unregistered/invalidated uses remain retained. No recovery of an approval or
 *   secret across restart is introduced here.
 */
