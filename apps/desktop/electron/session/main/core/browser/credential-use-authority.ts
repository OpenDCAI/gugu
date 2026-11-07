import { CredentialApprovalState, type CredentialApprovalClaim } from './credential-approval-state';
import { anySignal } from '@gugu/core/shared/anySignal';
import type {
  CredentialUseAuthority, CredentialUseBinding, CredentialUseCleanup, CredentialUseInvalidation,
  CredentialUseLease, VaultUseCapability,
} from './credential-use-contract';

const BINDING_KEYS = ['requestId', 'useId', 'accountId', 'installationId', 'agentId', 'sessionId', 'browserId',
  'loginSurfaceId', 'loginSurfaceEpoch', 'documentId', 'frameId', 'formFingerprint', 'credentialId',
  'credentialVersion', 'lockEpoch', 'origin', 'operation'] as const;
type Use = {
  binding: CredentialUseBinding; claim: CredentialApprovalClaim; signal: AbortSignal;
  controller: AbortController; claimed: boolean; cleanup?: Promise<CredentialUseCleanup>;
};
type AuthorityHost = {
  approval: Pick<CredentialApprovalState, 'claimStart' | 'assertStarted' | 'claimSubmission' | 'invalidate' | 'cancel'>;
  /** Checks the actual private surface identity, isolation readiness and caller binding. */
  isolationCurrent(binding: CredentialUseBinding): boolean;
  /**
   * Synchronously registers the original identity in the fixed handback lifecycle BEFORE issuance.
   * This signal represents approval revocation only; proof-only cleanup does not abort it.
   * A missing/async registration must never release a capability to storage.
   */
  registerUse(capability: VaultUseCapability, binding: CredentialUseBinding, revoked: AbortSignal): void;
  /** Proof only. The fixed coordinator owns audit/outcome decisions and any later handback. */
  cleanup(binding: CredentialUseBinding): Promise<CredentialUseCleanup>;
};

export class CredentialUseAuthorityError extends Error {
  constructor(readonly code: 'capability_unavailable' | 'binding_mismatch' | 'isolation_unavailable') { super(code); }
}

/**
 * In-process bridge to the ONE approval/submission state. No password, audit writer, tool, UI or
 * handback path is registered here. Construct only with fixed trusted isolation/cleanup adapters;
 * synthetic adapters are development fixtures and must never make the real vault available.
 */
export class CredentialUseAuthorityBridge implements CredentialUseAuthority {
  private readonly capabilities = new WeakMap<object, Use>();
  private readonly uses = new Map<string, Use>();
  private readonly host: Readonly<AuthorityHost>;

  constructor(host: AuthorityHost) {
    const approval = host.approval;
    this.host = Object.freeze({
      approval: Object.freeze({ claimStart: approval.claimStart.bind(approval), assertStarted: approval.assertStarted.bind(approval),
        claimSubmission: approval.claimSubmission.bind(approval), invalidate: approval.invalidate.bind(approval), cancel: approval.cancel.bind(approval) }),
      isolationCurrent: host.isolationCurrent.bind(host), registerUse: host.registerUse.bind(host), cleanup: host.cleanup.bind(host),
    });
  }

  /** Host-only issuance after an actual local decision; caller-supplied confirmation is never accepted. */
  issue(requestId: string, current: CredentialUseBinding): VaultUseCapability {
    const binding = Object.freeze(Object.fromEntries(BINDING_KEYS.map(key => [key, current[key]]))) as CredentialUseBinding;
    this.assertIsolation(binding);
    const started = this.host.approval.claimStart(requestId, binding);
    const controller = new AbortController();
    const use: Use = { binding: started.binding, claim: started.claim,
      signal: anySignal([started.signal, controller.signal]), controller, claimed: false };
    // A re-entrant isolation guard can revoke this very request; recheck AFTER the start claim.
    this.assertCurrent(use);
    if (this.uses.has(binding.useId)) {
      controller.abort();
      throw new CredentialUseAuthorityError('capability_unavailable');
    }
    const capability = Object.freeze({}) as VaultUseCapability;
    try {
      const registered: unknown = this.host.registerUse(capability, use.binding, started.signal);
      if (registered && (typeof registered === 'object' || typeof registered === 'function') && 'then' in registered) {
        // Observe late rejection, but never accept async completion as registration proof.
        void Promise.resolve(registered).catch(() => {});
        throw new Error('async_registration');
      }
      this.assertCurrent(use);
    } catch {
      controller.abort();
      this.host.approval.cancel(requestId, use.binding);
      throw new CredentialUseAuthorityError('capability_unavailable');
    }
    this.uses.set(binding.useId, use);
    this.capabilities.set(capability, use);
    return capability;
  }

  claimCredentialSink(capability: VaultUseCapability, current: CredentialUseBinding): CredentialUseLease {
    const use = capability && typeof capability === 'object' ? this.capabilities.get(capability) : undefined;
    if (!use || use.claimed || use.signal.aborted) throw new CredentialUseAuthorityError('capability_unavailable');
    // Consume the attempt before validation. Neither a mismatch nor an error can revive this capability.
    use.claimed = true;
    if (BINDING_KEYS.some(key => use.binding[key] !== current[key])) {
      this.revoke(use);
      throw new CredentialUseAuthorityError('binding_mismatch');
    }
    this.assertCurrent(use);
    return Object.freeze({
      signal: use.signal,
      assertCurrent: () => this.assertCurrent(use),
      claimSubmission: () => {
        this.assertCurrent(use);
        this.host.approval.claimSubmission(use.claim, use.binding);
      },
    });
  }

  invalidate(accountId: string, reason: CredentialUseInvalidation, credentialId?: string): void {
    // Revoke before any asynchronous cleanup. Unlock cannot revive these object identities.
    this.host.approval.invalidate(accountId, reason, credentialId);
    for (const use of this.uses.values()) if (use.binding.accountId === accountId
      && (!credentialId || use.binding.credentialId === credentialId)) use.controller.abort();
  }

  cleanup(useId: string): Promise<CredentialUseCleanup> {
    const use = this.uses.get(useId);
    if (!use) return Promise.resolve({ status: 'isolated_login_retained' });
    // Stop future fill/submit synchronously, including when cleanup is called after lock/navigation.
    use.controller.abort();
    use.cleanup ??= Promise.resolve().then(async () => {
      try {
        const result = await this.host.cleanup(use.binding);
        return Object.freeze({ status: result?.status === 'cleaned' ? 'cleaned' : 'isolated_login_retained' } as const);
      } catch { return Object.freeze({ status: 'isolated_login_retained' } as const); }
    });
    return use.cleanup;
  }

  private assertIsolation(binding: CredentialUseBinding): void {
    let ready: boolean;
    try { ready = this.host.isolationCurrent(binding); }
    catch { throw new CredentialUseAuthorityError('isolation_unavailable'); }
    if (ready !== true) throw new CredentialUseAuthorityError('isolation_unavailable');
  }

  private assertCurrent(use: Use): void {
    if (use.signal.aborted) throw new CredentialUseAuthorityError('capability_unavailable');
    try {
      this.assertIsolation(use.binding);
      // Approval checks its fixed host guard again; a re-entrant isolation check cannot restore a use.
      this.host.approval.assertStarted(use.claim, use.binding);
      if (use.signal.aborted) throw new CredentialUseAuthorityError('capability_unavailable');
    } catch (error) {
      this.revoke(use);
      throw error;
    }
  }

  /** Fault revocation reaches the lifecycle; intentional proof-only cleanup uses only its local controller. */
  private revoke(use: Use): void {
    use.controller.abort();
    this.host.approval.cancel(use.binding.requestId, use.binding);
  }
}
