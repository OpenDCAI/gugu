import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { extensionSurfaceStore } from './extension-surface-store';
import { installedExtensionsStore } from './installed-extensions-store';

/**
 * The entries an extension declared for one of its tabs, and how a click gets
 * back to it.
 *
 * Declarative both ways: the manifest says what exists, the host decides where
 * it is drawn and when it is reachable, and the id travels back untouched. The
 * host never learns what a command means — that is the extension's business,
 * and not knowing is what keeps this from turning into a host API surface an
 * extension can lean on. Refs #2374.
 */

export interface ExtensionDeclaredCommand {
  id: string;
  title: string;
}

function contributionFor(kind: string) {
  const [extensionId, ...rest] = kind.split('.');
  const tabName = rest.join('.');
  return installedExtensionsStore
    .manifestFor(extensionId ?? '')
    ?.contributes.tabs.find((tab) => tab.name === tabName);
}

export function declaredMenuCommands(kind: string): ExtensionDeclaredCommand[] {
  return contributionFor(kind)?.menu ?? [];
}

export function declaredToolbarCommands(kind: string): ExtensionDeclaredCommand[] {
  return contributionFor(kind)?.toolbar ?? [];
}

/**
 * Sends one declared command to the surface currently drawing this tab.
 *
 * A tab whose surface has not bound yet (or has gone away) has nothing to tell,
 * and says so rather than swallowing the click: an entry that looks live and
 * does nothing is the same fake as a placeholder button.
 */
export function runExtensionCommand(sessionId: string | null, tabId: string, commandId: string): void {
  const webContentsId = extensionSurfaceStore.state(sessionId, tabId).webContentsId;
  if (webContentsId === null) {
    log.warn(`Extension command ${commandId} ignored: this tab has no running surface`);
    return;
  }
  void rpc.extensions
    .invokeCommand({ webContentsId, commandId })
    .then((result) => {
      if (!result.success) log.warn('Extension command refused:', result.error);
    })
    .catch((error: unknown) => {
      log.warn('Extension command failed:', error);
    });
}
