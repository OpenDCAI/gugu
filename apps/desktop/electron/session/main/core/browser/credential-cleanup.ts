import type { CredentialUseBinding, CredentialUseCleanup } from './credential-use-contract';

/** Fixed host consumers, including console/network, captures, temporary output and crash/error reporting.
 * quiesce must stop and drain actual writers; clearing queued results alone is insufficient.
 * No consumer may capture sensitive material first and rely on this cleanup to hide it.
 */
export interface CredentialArtifactCleanup {
  quiesce(binding: CredentialUseBinding): Promise<boolean>;
  clear(binding: CredentialUseBinding): Promise<boolean>;
  verify(binding: CredentialUseBinding): Promise<boolean>;
}

export interface CredentialCleanupSurface {
  clearFilledFields(binding: CredentialUseBinding): Promise<{ status: 'cleared' | 'isolated_login_retained' }>;
  /** Normal retirement checks the last inspected document synchronously before destruction. */
  destroy(binding: CredentialUseBinding, expectedDocumentEpoch?: string): Promise<{ status: 'destroyed' | 'isolated_login_retained' }>;
}

/** Per-use cleanup, not an approval ledger. Retiring contents eliminates old console/execution contexts.
 * A person may need the isolated page for a second factor: scrub now, retire only on completion/failure.
 * A genuine cleanup fault is permanent for this use, even if a later attempt clears more resources.
 */
export class CredentialCleanup {
  private tail: Promise<unknown> = Promise.resolve();
  private fault = false;
  private retired = false;
  private cleared = false;
  private retirement: Promise<boolean> | undefined;
  private readonly surface: CredentialCleanupSurface;
  private readonly artifacts: CredentialArtifactCleanup;

  constructor(private readonly binding: CredentialUseBinding, surface: CredentialCleanupSurface,
    artifacts: CredentialArtifactCleanup) {
    this.surface = Object.freeze({ clearFilledFields: surface.clearFilledFields.bind(surface), destroy: surface.destroy.bind(surface) });
    this.artifacts = Object.freeze({ quiesce: artifacts.quiesce.bind(artifacts), clear: artifacts.clear.bind(artifacts), verify: artifacts.verify.bind(artifacts) });
  }

  get failed(): boolean { return this.fault; }
  get destroyed(): boolean { return this.retired; }
  get confirmed(): boolean { return this.retired && this.cleared && !this.fault; }

  /** Emergency destruction must not wait behind an outstanding completion read/field script.
   * This is only native retirement, never a complete cleanup proof or permission to hand back.
   */
  async retire(expectedDocumentEpoch?: string): Promise<boolean> {
    if (this.retired) return true;
    if (this.retirement) {
      const operation = this.retirement;
      const previous = await operation;
      if (previous || expectedDocumentEpoch !== undefined) return previous;
      if (this.retirement !== operation) return this.retire(expectedDocumentEpoch);
      // A stale document fence can fail; fault cleanup may still destroy the isolated surface.
    }
    this.retirement = this.check(async () => (await this.surface.destroy(this.binding, expectedDocumentEpoch)).status === 'destroyed');
    this.retired = await this.retirement;
    return this.retired;
  }

  /** Neither a scrub nor a complete proof can navigate/unblock the Agent destination. */
  run(retire: boolean, expectedDocumentEpoch?: string): Promise<CredentialUseCleanup> {
    const work = this.tail.then(async () => {
      if (this.confirmed) return { status: 'cleaned' as const };
      if (!this.retired) await this.check(async () => (await this.surface.clearFilledFields(this.binding)).status === 'cleared');
      await this.check(() => this.artifacts.quiesce(this.binding));
      if (retire && !this.retired) {
        await this.retire(expectedDocumentEpoch);
        // Destruction can itself finish queued console/error/file callbacks. Drain them before removal.
        await this.check(() => this.artifacts.quiesce(this.binding));
      }
      const removed = await this.check(() => this.artifacts.clear(this.binding));
      const absent = await this.check(() => this.artifacts.verify(this.binding));
      this.cleared = removed && absent;
      return { status: this.confirmed ? 'cleaned' as const : 'isolated_login_retained' as const };
    });
    this.tail = work;
    return work;
  }

  private async check(operation: () => Promise<boolean>): Promise<boolean> {
    try { if (await operation() === true) return true; } catch { /* Never retain a page/error payload. */ }
    this.fault = true;
    return false;
  }
}
