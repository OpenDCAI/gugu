import { when } from 'mobx';
import { revealSessionpage } from '@/hooks/useSessionpageReveal';
import { messageForUser } from '@/lib/userFacingError';
import { auxWindows } from '@renderer/app/aux-windows';
import { commandRegistry } from '@renderer/lib/commands/registry';
import type { CommandProvider } from '@renderer/lib/commands/types';
import { toast } from '@renderer/lib/hooks/use-toast';
import { openApp } from './app-dock';
import { declaredMenuCommands, declaredToolbarCommands, runExtensionCommand } from './extension-commands';
import { extensionSurfaceStore } from './extension-surface-store';
import { extensionViewStore, residentPageKey } from './extension-view-store';
import { installedExtensionsStore, type ExtensionTabContributionEntry } from './installed-extensions-store';

/** The dock chooses the existing page; its toolbar/menu's binding delivers the command once it is ready. */
async function openAndRun(tab: ExtensionTabContributionEntry, commandId: string): Promise<void> {
  const opened = openApp(tab.extensionId, tab.kind.slice(tab.extensionId.length + 1));
  revealSessionpage();
  const sessionId = opened !== 'own' && 'session' in opened ? opened.session : null;
  const place = sessionId && tab.perSession ? `session:${sessionId}` : 'app';
  const target = () => {
    const windowed = auxWindows.windowOfApp(tab.kind);
    if (windowed) return { sessionId: null, tabId: `window:${windowed.id}` };
    const claim = extensionViewStore.claims.get(residentPageKey(tab.kind, place));
    return claim && (claim.sessionId ?? null) === sessionId ? { sessionId, tabId: claim.tabId } : null;
  };
  try {
    await when(() => {
      const slot = target();
      return slot !== null && extensionSurfaceStore.state(slot.sessionId, slot.tabId).webContentsId !== null;
    }, { timeout: 10_000 });
  } catch {
    throw new Error(`${tab.extensionName}: the App page did not become ready. Open the App and try the command again.`);
  }
  const slot = target();
  if (!slot) throw new Error(`${tab.extensionName}: the App page was closed.`);
  runExtensionCommand(slot.sessionId, slot.tabId, commandId);
}

export function createExtensionCommandProvider(): CommandProvider {
  return {
    scopeId: 'app',
    getCommands: () => installedExtensionsStore.allTabContributions
      // A file opener needs the file selected by its own menu, not a blank global App page.
      .filter((tab) => tab.enabled && !tab.forFiles && !tab.hostSettings && !tab.hostBrowser)
      .flatMap((tab) => [...new Map([...declaredMenuCommands(tab.kind), ...declaredToolbarCommands(tab.kind)]
        .map((command) => [command.id, command])).values()].map((command) => ({
        id: `extension:${tab.kind}:${command.id}` as const,
        label: `${tab.extensionName}: ${command.title}`,
        description: tab.title,
        execute: () => {
          void openAndRun(tab, command.id).catch((error: unknown) => toast({ title: messageForUser(error), variant: 'destructive' }));
        },
      }))),
  };
}

export function setupExtensionCommandProvider(): void {
  commandRegistry.register(createExtensionCommandProvider());
}
