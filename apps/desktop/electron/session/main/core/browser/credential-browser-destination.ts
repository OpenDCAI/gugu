import { captureCredentialBrowserSlot } from './browser-page-views';
import { copyCredentialBinding, credentialBindingMatches } from './credential-binding';
import { CredentialPartitionIsolation } from './credential-partition-isolation';
import { assertCredentialWebsite } from './credential-website';
import type { CredentialUseBinding } from './credential-use-contract';
import type { FreshCredentialDestinationPort } from './credential-handoff-target';

/** Fixed native adapter only. No vault, person decision, tool or availability switch is registered.
 * Capture the original tab presentation BEFORE physically retiring it. The fresh renderer is never
 * the login renderer, never reuses old Agent tasks and stays unregistered until B-3's final publish.
 */
export async function prepareCredentialBrowserPartition(binding: CredentialUseBinding): Promise<{
  isolation: CredentialPartitionIsolation; destination: FreshCredentialDestinationPort;
}> {
  const fixed = copyCredentialBinding(binding);
  const slot = captureCredentialBrowserSlot(fixed);
  const isolation = await CredentialPartitionIsolation.prepare(fixed, slot.source);
  let attempted = false;
  const assertCurrent = (current: CredentialUseBinding) => {
    try {
      if (!credentialBindingMatches(fixed, current)) throw new Error('credential_handoff_binding_mismatch');
      slot.assertCurrent(); isolation.assertLifecycleCurrent(current);
    } catch (error) { isolation.invalidate(); throw error; }
  };
  const destination: FreshCredentialDestinationPort = Object.freeze({ assertCurrent,
    prepare: async (current: CredentialUseBinding) => {
      assertCurrent(current);
      if (attempted) throw new Error('credential_handoff_already_prepared');
      attempted = true;
      const candidate = isolation.prepareCandidate(slot.create);
      let loaded = false, loading = false, published = false, confirmed = false, disposed = false;
      let disposal: Promise<void> | undefined;
      const dispose = (): Promise<void> => {
        if (confirmed) return Promise.resolve();
        disposed = true; isolation.retractCandidate(candidate.webContents);
        disposal ??= new Promise<void>((resolve, reject) => {
          const contents = candidate.webContents;
          if (contents.isDestroyed()) { resolve(); return; }
          const done = () => { clearTimeout(timer); contents.isDestroyed() ? resolve() : reject(new Error('credential_candidate_retirement_unconfirmed')); };
          const timer = setTimeout(() => { contents.removeListener('destroyed', done); reject(new Error('credential_candidate_retirement_unconfirmed')); }, 5_000);
          contents.once('destroyed', done);
          try { candidate.dispose(); }
          catch { clearTimeout(timer); contents.removeListener('destroyed', done); reject(new Error('credential_candidate_retirement_unconfirmed')); }
        });
        return disposal;
      };
      return Object.freeze({
        loadOrigin: async (origin: string) => {
          try {
            if (loading || disposed || published || origin !== fixed.origin) throw new Error('credential_handoff_unavailable');
            loading = true;
            assertCredentialWebsite(origin, fixed.origin);
            const navigation = await candidate.runtime.prepareNavigation(fixed.origin);
            assertCurrent(fixed);
            if (disposed) throw new Error('credential_handoff_unavailable');
            // No await between the last physical ownership check and actual native loadURL.
            await navigation.commit();
            assertCurrent(fixed);
            if (disposed || candidate.webContents.isDestroyed()) throw new Error('credential_handoff_unavailable');
            assertCredentialWebsite(candidate.webContents.getURL(), fixed.origin);
            loaded = true;
          } catch (error) { try { await dispose(); } catch { /* Physical fault remains latched. */ } throw error; }
        },
        publish: () => {
          try {
            assertCurrent(fixed);
            if (!loaded || disposed || published) throw new Error('credential_handoff_unavailable');
            isolation.publishCandidate(candidate.webContents, candidate.publish);
            published = true;
            return { status: 'published' as const };
          } catch (error) { isolation.invalidate(); throw error; }
        },
        retract: () => { if (!confirmed) { void dispose().catch(() => {}); } },
        confirm: () => {
          assertCurrent(fixed);
          if (!published || disposed || confirmed) throw new Error('credential_handoff_confirmation_unavailable');
          isolation.confirmCandidate(candidate.webContents);
          confirmed = true;
        },
        dispose,
      });
    },
  });
  return Object.freeze({ isolation, destination });
}
