import type { ExtensionManifest } from '@shared/extensions/manifest';
import { LOCAL_EXTENSIONS_HOST, type ExtensionsHost } from './extensions-host';
import { registerExtensionTabs, unregisterExtensionTabs } from './register-extension-tabs';

/**
 * Switch an installed extension off or on — the rung between installed and
 * uninstalled (owner, #5265: 可用/不可用). One function for both places that
 * offer the switch (the workspace panel and Settings → Extensions).
 *
 * Optimistic: the store flips first so the switch moves on the click; the
 * write follows, and a refused write flips it back and throws so the caller
 * can say so with a way to retry. On success main's list wins, and the tab
 * providers follow the switch: off closes its open tabs and withdraws the
 * providers — not the uninstall placeholder, which for a deliberate "stop
 * showing it" would be litter (owner, #5265) — and on registers them again.
 */
export async function setExtensionEnabled(
  manifest: ExtensionManifest,
  enabled: boolean,
  /** 资源库看的是另一台咕咕桌面时(#6264):开关的是那台机器上的,tab 由它自己的窗口跟进。 */
  host: ExtensionsHost = LOCAL_EXTENSIONS_HOST
): Promise<void> {
  const store = host.store;
  const before = store.disabled;
  store.applyDisabled(
    enabled ? before.filter((id) => id !== manifest.id) : [...new Set([...before, manifest.id])]
  );
  try {
    const result = await host.api.setEnabled({ extensionId: manifest.id, enabled });
    if (!result.success || !result.data) {
      throw new Error(result.error ?? '');
    }
    store.applyDisabled(result.data.disabled);
  } catch (error) {
    store.applyDisabled(before);
    throw error;
  }
  if (!host.local) return;
  if (enabled) {
    registerExtensionTabs(manifest);
  } else {
    unregisterExtensionTabs(
      manifest.id,
      manifest.contributes.tabs.map((contribution) => contribution.name),
      { closeOpenTabs: true }
    );
  }
}
