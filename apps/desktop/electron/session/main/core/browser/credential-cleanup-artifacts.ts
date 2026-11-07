import type { CredentialUseBinding } from './credential-use-contract';
import type { CredentialArtifactCleanup } from './credential-cleanup';

/** Every normal feature-owned output class must have an explicit host custodian, even when its
 * correct configuration forbids producing output. Missing coverage must never default to clean.
 */
export const CREDENTIAL_ARTIFACT_KINDS = ['console', 'network', 'captures', 'temporary', 'crash', 'errors'] as const;
export type CredentialArtifactKind = typeof CREDENTIAL_ARTIFACT_KINDS[number];

/** Construct before secret use. No dynamic/Agent registration or raw event/error payload is retained. */
export function credentialArtifactCleanup(
  custodians: Readonly<Record<CredentialArtifactKind, CredentialArtifactCleanup>>,
): CredentialArtifactCleanup {
  const fixed = CREDENTIAL_ARTIFACT_KINDS.map(kind => {
    const custodian = custodians[kind];
    return custodian ? { quiesce: custodian.quiesce?.bind(custodian), clear: custodian.clear?.bind(custodian),
      verify: custodian.verify?.bind(custodian) } : undefined;
  });
  const run = async (method: keyof CredentialArtifactCleanup, binding: CredentialUseBinding): Promise<boolean> => {
    if (method === 'quiesce') {
      // Close ALL admissions before waiting for any consumer's real in-flight work.
      const closed = await Promise.all(fixed.map(async custodian => {
        try { return typeof custodian?.quiesce === 'function' && await custodian.quiesce(binding) === true; }
        catch { return false; }
      }));
      return closed.every(Boolean);
    }
    // A failed custodian cannot skip other outputs that still need clearing. Do not short-circuit.
    let success = true;
    for (const custodian of fixed) {
      const operation = custodian?.[method];
      try { if (typeof operation !== 'function' || await operation(binding) !== true) success = false; }
      catch { success = false; }
    }
    return success;
  };
  return Object.freeze({ quiesce: (binding: CredentialUseBinding) => run('quiesce', binding),
    clear: (binding: CredentialUseBinding) => run('clear', binding), verify: (binding: CredentialUseBinding) => run('verify', binding) });
}

/** Tracks feature-owned callbacks already issued to a custodian. sealAndDrain closes admission
 * synchronously and awaits real completion, not the observer-facing cancellation/timeout promise.
 * It is cleanup plumbing, not permission to capture a sensitive page. No timeout releases this gate.
 */
export class CredentialOutputDrain {
  private sealed = false;
  private failed = false;
  private readonly pending = new Set<Promise<void>>();

  run(work: () => Promise<void>): Promise<void> {
    if (this.sealed) return Promise.reject(new Error('credential_output_closed'));
    // Register before invoking host work, which can synchronously re-enter cleanup.
    const operation = Promise.resolve().then(work);
    const settled = operation.then(() => undefined, () => {
      this.failed = true;
      throw new Error('credential_output_failed');
    });
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled), () => this.pending.delete(settled));
    return settled;
  }

  async sealAndDrain(): Promise<boolean> {
    this.sealed = true;
    await Promise.allSettled([...this.pending]);
    return !this.failed && this.pending.size === 0;
  }
}
