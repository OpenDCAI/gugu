import { CredentialHandoff } from './credential-handoff';
import type { CredentialUseBinding, VaultUseCapability } from './credential-use-contract';
import type { CredentialUseSettlement, FixedVaultUseSettlementSink } from './credential-settlement-contract';

/** Trusted composition only. Tracks lifecycle owners, never approvals or submission rights.
 * registerUse is the synchronous Authority hook; settle is fixed on storage's browser sink.
 * No lookup by a caller-supplied use id can substitute for the original capability identity.
 */
export class CredentialHandoffRegistry implements FixedVaultUseSettlementSink {
  private readonly capabilities = new WeakMap<VaultUseCapability, CredentialHandoff>();
  private readonly uses = new Map<string, CredentialHandoff>();

  constructor(private readonly create: (capability: VaultUseCapability, binding: CredentialUseBinding,
    revokedSignal: AbortSignal) => CredentialHandoff) {}

  registerUse(capability: VaultUseCapability, binding: CredentialUseBinding, revokedSignal: AbortSignal): void {
    if (this.capabilities.has(capability) || this.uses.has(binding.useId)) throw new Error('credential_use_already_registered');
    const lifecycle = this.create(capability, binding, revokedSignal);
    if (!(lifecycle instanceof CredentialHandoff)) throw new Error('credential_lifecycle_unavailable');
    this.capabilities.set(capability, lifecycle);
    this.uses.set(binding.useId, lifecycle);
  }

  async settle(event: CredentialUseSettlement): Promise<void> {
    const lifecycle = this.capabilities.get(event.capability);
    if (!lifecycle || this.uses.get(event.binding.useId) !== lifecycle) throw new Error('credential_settlement_rejected');
    await lifecycle.settle(event.capability, event.binding,
      { outcome: event.outcome, effectPossible: event.effectPossible, audit: event.postUseAudit });
  }

  cleanup(useId: string) {
    const lifecycle = this.uses.get(useId);
    return lifecycle ? lifecycle.cleanup(useId) : Promise.resolve({ status: 'isolated_login_retained' as const,
      disposition: 'fault' as const, reason: 'target_invalidated' as const });
  }

  /** Host navigation events/person UI only; these methods are not Agent or generic Ask actions. */
  refresh(useId: string) { return this.require(useId).refresh(); }
  personView(useId: string) { return this.require(useId).view(); }
  requestContinue(useId: string, evidence: unknown) { return this.require(useId).requestContinue(evidence); }

  private require(useId: string): CredentialHandoff {
    const lifecycle = this.uses.get(useId);
    if (!lifecycle) throw new Error('credential_use_unavailable');
    return lifecycle;
  }
}
