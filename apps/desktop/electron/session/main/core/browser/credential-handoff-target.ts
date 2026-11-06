import type { BrowserPageRuntime } from './browser-page-runtime';
import type { CredentialUseBinding } from './credential-use-contract';
import { assertCredentialWebsite } from './credential-website';
import type { PreparedCredentialHandoff } from './credential-handoff';

/** The actual destination runtime is resolved by the trusted host from the captured actor/tab binding.
 * No private contents, full redirect URL, title, query or form data are transferred.
 */
export async function prepareCredentialHandoffTarget(
  runtime: BrowserPageRuntime, binding: CredentialUseBinding, assertCurrent: () => void,
): Promise<PreparedCredentialHandoff> {
  assertCredentialWebsite(binding.origin, binding.origin);
  const origin = binding.origin;
  const prepared = await runtime.prepareNavigation(origin);
  assertCurrent();
  let discarded = false;
  return { commit: () => {
    if (discarded) throw new Error('credential_handoff_unavailable');
    // These checks and actual loadURL dispatch are in the same synchronous call stack.
    assertCurrent();
    return prepared.commit();
  }, discard: async () => { discarded = true; } };
}

export interface FreshCredentialDestinationPort {
  assertCurrent(binding: CredentialUseBinding): void;
  /** The retired Agent contents/runtime cannot be reused. The fresh target remains unregistered. */
  prepare(binding: CredentialUseBinding): Promise<{
    /** Starts actual native loading synchronously; no Agent registration or observation. */
    loadOrigin(origin: string): Promise<void>;
    /** Synchronously verifies/reserves ownership and publishes the prepared native target. No await. */
    publish(): { status: 'published' };
    dispose(): Promise<void>;
  }>;
}

/** Production handback seam for a partition whose old Agent runtime has actually retired.
 * The fixed native registry supplies allocation/publication; absent that adapter, handback is unavailable.
 */
export async function prepareFreshCredentialHandoffTarget(
  binding: CredentialUseBinding, port: FreshCredentialDestinationPort,
): Promise<PreparedCredentialHandoff> {
  assertCredentialWebsite(binding.origin, binding.origin);
  const origin = binding.origin;
  const destination = await port.prepare(binding);
  try {
    port.assertCurrent(binding);
    await destination.loadOrigin(origin);
    port.assertCurrent(binding);
  } catch {
    try { await destination.dispose(); } catch { /* Retain failure; never publish from cleanup. */ }
    throw new Error('credential_handoff_unavailable');
  }
  let consumed = false, discarded = false;
  return {
    commit: () => {
      if (consumed || discarded) throw new Error('credential_handoff_unavailable');
      consumed = true;
      try {
        port.assertCurrent(binding);
        if (destination.publish()?.status !== 'published') throw new Error('credential_handoff_unavailable');
      } catch { throw new Error('credential_handoff_unavailable'); }
      return Promise.resolve();
    },
    discard: async () => { if (!discarded) { discarded = true; await destination.dispose(); } },
  };
}
