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
  }, retract: () => { discarded = true; }, confirm: assertCurrent,
  discard: async () => { discarded = true; } };
}

export interface FreshCredentialDestinationPort {
  assertCurrent(binding: CredentialUseBinding): void;
  /** The retired Agent contents/runtime cannot be reused. The fresh target remains unregistered. */
  prepare(binding: CredentialUseBinding): Promise<{
    /** Starts actual native loading synchronously; no Agent registration or observation. */
    loadOrigin(origin: string): Promise<void>;
    /** Registers the prepared native target while Agent observation remains blocked. No await. */
    publish(): { status: 'published' };
    retract(): void;
    /** Opens admission only at B-3's final synchronous handshake; no external callbacks. */
    confirm(): void;
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
  const assertCurrent = port.assertCurrent.bind(port);
  const candidate = await port.prepare(binding);
  const destination = Object.freeze({ loadOrigin: candidate.loadOrigin.bind(candidate), publish: candidate.publish.bind(candidate),
    retract: candidate.retract.bind(candidate), confirm: candidate.confirm.bind(candidate), dispose: candidate.dispose.bind(candidate) });
  try {
    assertCurrent(binding);
    await destination.loadOrigin(origin);
    assertCurrent(binding);
  } catch {
    try { destination.retract(); } catch { /* Still attempt actual disposal. */ }
    try { await destination.dispose(); } catch { /* Retain failure; never publish from cleanup. */ }
    throw new Error('credential_handoff_unavailable');
  }
  let consumed = false, discarded = false, confirmed = false;
  let disposal: Promise<void> | undefined;
  const retract = () => {
    if (!confirmed && !discarded) { discarded = true; destination.retract(); }
  };
  return {
    commit: () => {
      if (consumed || discarded) throw new Error('credential_handoff_unavailable');
      consumed = true;
      try {
        assertCurrent(binding);
        if (destination.publish()?.status !== 'published') throw new Error('credential_handoff_unavailable');
      } catch { throw new Error('credential_handoff_unavailable'); }
      return Promise.resolve();
    },
    retract,
    confirm: () => {
      if (!consumed || discarded || confirmed) throw new Error('credential_handoff_unavailable');
      assertCurrent(binding); destination.confirm(); confirmed = true;
    },
    discard: () => {
      if (confirmed) return Promise.resolve();
      if (!disposal) {
        try { retract(); } catch { /* Still attempt actual disposal. */ }
        try { disposal = Promise.resolve(destination.dispose()); }
        catch { disposal = Promise.reject(new Error('credential_destination_cleanup_unconfirmed')); }
      }
      return disposal;
    },
  };
}
