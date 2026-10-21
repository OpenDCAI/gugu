import { autoUpdatesFrom } from '@shared/extensions/market-entries';
import { log } from '@main/lib/logger';
import { extensionsService } from './extensions-root';
import { installExtensionFromMarket, type MarketInstallDependencies } from './extension-market-install';
import { installPlan } from './install-plan';
import type { CloudExtensionMarket } from './market-catalog';

/**
 * Market Apps update by themselves (owner 10-19「app 版本管理 参考 vscode extension 版本管理」「1 可以」), as VS Code's
 * extensions do (`extensions.autoUpdate` defaults to on). Which ones: installed from the market, switched on, their
 * 「自动更新」 not off (VS Code `shouldAutoUpdateExtension`: pinned, excluded and disabled ones are skipped,
 * https://github.com/microsoft/vscode/blob/af18ca5130bd7164867b2784b3aba68b4de38116/src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts#L2337-L2372 ).
 * A version that would ask the person (it declares more) is not put in by itself — it waits for their 「更新」, as VS Code
 * leaves an update needing consent (#L2269-L2312). The update is the one 「更新」 runs (`installExtensionFromMarket`), its
 * yes the press it would be (`return`, then `given` on these bytes): no second way to land an App.
 *
 * When: whenever the market's index comes in changed (opening the 「App」 page, an install), and once a start — no timer
 * (product spec: ❌ 轮询; gugu's own update restarts it often enough).
 */

export interface AutoUpdateDependencies extends MarketInstallDependencies {
  market?: Pick<CloudExtensionMarket, 'updatesFor' | 'entry' | 'materialize' | 'hold' | 'held' | 'discard'>;
}

/** One pass: what is updated here now. Each App on its own — one that fails is logged and the rest go on. */
export async function autoUpdateAppsOnce(dependencies: AutoUpdateDependencies = {}): Promise<{ id: string; from: string; version: string }[]> {
  const market = dependencies.market ?? (await import('./market-catalog-root')).cloudExtensionMarket();
  const service = extensionsService();
  const origins = service.origins();
  const off = new Set(service.autoUpdateOffIds());
  const eligible = service
    .list()
    .extensions.filter(({ manifest }) => origins[manifest.id] === 'market' && service.isEnabled(manifest.id) && !off.has(manifest.id))
    .map(({ manifest }) => ({ id: manifest.id, version: manifest.version }));
  if (eligible.length === 0) return [];
  const updated: { id: string; from: string; version: string }[] = [];
  for (const update of autoUpdatesFrom(await market.updatesFor(eligible), eligible)) {
    const ref = { extensionId: update.id, version: update.version };
    try {
      // Read off the index's copy of its manifest first: one that would ask is not downloaded for nothing at every start.
      const offered = await market.entry(update.id);
      if (offered?.version === update.version && installPlan(service, offered.manifest, 'market').asks) {
        log.info('auto-update: waits for the person (it asks for more)', update);
        continue;
      }
      const handed = await installExtensionFromMarket({ ref, consent: { kind: 'return' } }, { ...dependencies, market });
      if (handed.outcome !== 'ask') throw new Error(`the market install answered ${handed.outcome}`);
      if (handed.asks) {
        log.info('auto-update: waits for the person (it asks for more)', update);
        continue;
      }
      const done = await installExtensionFromMarket({ ref, consent: { kind: 'given', digest: handed.ask.manifestDigest } }, { ...dependencies, market });
      if (!done.installed) throw new Error(`the market install answered ${done.outcome}`);
      log.info('auto-update: updated', update);
      updated.push(update);
    } catch (error) {
      log.warn('auto-update: not updated', { ...update, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return updated;
}

let running: Promise<void> | null = null;
let again = false;

/** A pass, never two at once: asked while one runs, one more runs after it (the index or a switch changed meanwhile). */
export function autoUpdateApps(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await autoUpdateAppsOnce().catch((error: unknown) => log.warn('auto-update: the pass stopped', { error: String(error) }));
    } while (again);
  })().finally(() => {
    running = null;
  });
  return running;
}

/**
 * At boot, for the hosts that keep Apps — the desktop and 咕咕 server (`browserFeatures`, as first-run): the index is asked
 * for once, and every time it comes in changed a pass follows. 咕咕 server has no window to ask the index for: this is its
 * only way to get updates, and its Apps are agents' tools nobody presses 「更新」 for.
 */
export function autoUpdateAtBoot(browserFeatures: boolean): void {
  if (!browserFeatures) return;
  void (async () => {
    const market = (await import('./market-catalog-root')).cloudExtensionMarket();
    market.onRefreshed((refreshed) => {
      if (refreshed.outcome === 'changed') void autoUpdateApps();
    });
    await market.refresh();
    await autoUpdateApps();
  })().catch((error: unknown) => log.warn('auto-update: could not start', { error: String(error) }));
}
