import { log } from '@renderer/utils/logger';
import { sessionTabRegistry } from '@renderer/features/sessions/session-tab-registry';
import { createExtensionTabProvider } from './extension-tab-provider';
import { installedExtensionsStore } from './installed-extensions-store';
import { extensionTabKind, type ExtensionManifest } from '@shared/extensions/manifest';

/**
 * Loads what is installed and registers a tab provider per contribution.
 *
 * Runs off the critical path: an extension arriving late costs nothing, because
 * a tab whose provider is missing is held as a placeholder and promoted in
 * place the moment its provider registers (PaneStore). Blocking the mount on
 * this would trade the session page's open time for an inventory read. Refs #2374.
 */
export async function registerInstalledExtensionTabs(): Promise<void> {
  await installedExtensionsStore.load();
  for (const manifest of installedExtensionsStore.manifests) {
    // Switched-off extensions stay listed but are not offered: no provider, so
    // their tabs hold as the placeholder until the switch flips back (#5265).
    if (!installedExtensionsStore.isEnabled(manifest.id)) continue;
    registerExtensionTabs(manifest);
  }
}

/**
 * #6264 这台机器上装着的扩展被**别的桌面**改了(资源库切到这台机器后装 / 卸 / 开关):重读清单,让这个窗口跟上。
 * 新装或刚开的补上 provider;卸掉的撤下(开着的 tab 退回「未加载」占位,与本机卸载同一条);关掉的连 tab 一起关
 * (与本机「不可用」同一条)。
 */
export async function resyncInstalledExtensionTabs(): Promise<void> {
  const before = new Map(
    installedExtensionsStore.manifests.map((manifest) => [
      manifest.id,
      { manifest, enabled: installedExtensionsStore.isEnabled(manifest.id) },
    ])
  );
  await installedExtensionsStore.load();
  const after = new Set(installedExtensionsStore.manifests.map((manifest) => manifest.id));
  for (const manifest of installedExtensionsStore.manifests) {
    const enabled = installedExtensionsStore.isEnabled(manifest.id);
    const was = before.get(manifest.id);
    if (enabled) registerExtensionTabs(manifest);
    else if (was?.enabled) {
      unregisterExtensionTabs(
        manifest.id,
        manifest.contributes.tabs.map((tab) => tab.name),
        { closeOpenTabs: true }
      );
    }
  }
  for (const [id, { manifest }] of before) {
    if (after.has(id)) continue;
    unregisterExtensionTabs(
      id,
      manifest.contributes.tabs.map((tab) => tab.name)
    );
  }
  void installedExtensionsStore.checkUpdates();
}

/** Registers every tab one extension contributes — on install, and on switching it back on. */
export function registerExtensionTabs(manifest: ExtensionManifest): void {
  for (const contribution of manifest.contributes.tabs) {
    registerExtensionTabProvider(manifest.id, contribution.name);
  }
}

/**
 * Withdraws the tab providers an extension contributed, after it is uninstalled.
 *
 * Open tabs are not closed — the user did not close them — but they fall back to the
 *「未加载」placeholder, and the uninstalled extension's surface is torn down with the
 * resource. Leaving it registered would let a just-removed extension keep drawing
 * (and keep its webview alive) until the next restart, which is precisely the state a
 * user who uninstalls something they stopped trusting is trying to leave.
 *
 * Reinstalling re-registers the same kinds, and PaneStore promotes those very tabs
 * back in place. Refs #2374.
 */
export function unregisterExtensionTabs(
  extensionId: string,
  tabNames: readonly string[],
  options: {
    /**
     * Close the tabs first instead of leaving placeholders. For a disable the
     * user asked for from the panel: "stop showing it" must not leave litter
     * behind (owner, #5265). Uninstall keeps the placeholder rule above.
     */
    closeOpenTabs?: boolean;
  } = {}
): void {
  for (const tabName of tabNames) {
    const kind = extensionTabKind(extensionId, tabName);
    if (options.closeOpenTabs) sessionTabRegistry.closeKind(kind);
    sessionTabRegistry.unregister(kind);
  }
}

/**
 * Registers one contribution, tolerating a kind that is already registered.
 * Reinstalling an extension re-runs this while its providers are still live: the
 * existing provider stays and the tabs open against it keep working, and since
 * providers read their title from the store rather than a captured manifest, a
 * renamed tab still updates.
 */
function registerExtensionTabProvider(extensionId: string, tabName: string): void {
  const provider = createExtensionTabProvider(extensionId, tabName);
  if (sessionTabRegistry.has(provider.kind)) return;
  try {
    sessionTabRegistry.register(provider);
  } catch (error) {
    log.warn(`Failed to register extension tab provider ${provider.kind}:`, error);
  }
}
