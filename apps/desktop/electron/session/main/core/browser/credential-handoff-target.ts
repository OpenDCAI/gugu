import type { BrowserPageRuntime } from './browser-page-runtime';
import type { CredentialUseBinding } from './credential-use-contract';
import { assertCredentialWebsite } from './credential-website';

/** The actual destination runtime is resolved by the trusted host from the captured actor/tab binding.
 * No private contents, full redirect URL, title, query or form data are transferred.
 */
export async function prepareCredentialHandoffTarget(
  runtime: BrowserPageRuntime, binding: CredentialUseBinding, assertCurrent: () => void,
): Promise<{ commit(): Promise<void> }> {
  assertCredentialWebsite(binding.origin, binding.origin);
  const origin = binding.origin;
  const prepared = await runtime.prepareNavigation(origin);
  assertCurrent();
  return { commit: () => {
    // These checks and actual loadURL dispatch are in the same synchronous call stack.
    assertCurrent();
    return prepared.commit();
  } };
}
