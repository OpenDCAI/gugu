import type { ExtensionInstallConsentRequest, ExtensionInstallConsentResult } from '@shared/extensions/host-actions';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { isGuguOwnApp } from '@shared/extensions/first-run';
import { pinsAutoUpdate } from '@shared/extensions/market-entries';
import { marketDownloadProgressChannel } from '@shared/extensions/marketEvents';
import { events } from '@main/lib/events';
import { applyInstalledExtension } from './extension-after-install';
import { announceInstalledChanged } from './extension-bridge-relay';
import { extensionsService } from './extensions-root';
import { installPlan } from './install-plan';
import { installPrepared, type InstallDependencies } from './install-prepared';
import type { CloudExtensionMarket, MarketPrepared } from './market-catalog';
import type { HandedConsent } from '@shared/extensions/install-consent-flow';

export interface MarketInstall {
  /** Which App, and which of its versions — none: the one the market gives this machine now. */
  ref: { extensionId: string; version?: string };
  /** The chat it is installed for (a group's offer): where its tools are given at first (D-30), when it is a place. */
  chatId?: string;
  /**
   * Who asks the person, and where:
   * - none: here — the shell's sheet, or (an agent's install) the approval in its session (`requestInstallConsent`);
   * - `return`: what it would ask is handed back instead (`outcome: 'ask'`, `asks` false when it would ask nothing), always,
   *   never installed — the caller asks in its own place (the Apps page, the first-run page, another device) and comes back
   *   with `given`. The package downloaded and checked for it is kept until then (`market.hold`), so it is not fetched twice;
   * - `given`: installs what the person agreed to — these bytes only (`digest`), what it gives there being the install's own rule (InstallGrant);
   * - `gugu`: gugu's own App put in by gugu itself (the first-run set, @shared/extensions/first-run.ts): asks nobody — agreed
   *   to as gugu reviewed it, as a preinstalled App was; its capabilities recorded as its manifest says, every agent here (as
   *   an App nobody chose for). Only for an App whose code is in gugu's own repository, and only as a first install.
   */
  consent?: HandedConsent | { kind: 'gugu' };
}

export interface MarketInstallDependencies extends InstallDependencies {
  market?: Pick<CloudExtensionMarket, 'entry' | 'materialize' | 'hold' | 'held' | 'discard'>;
}

/** The App this was, in every outcome. */
interface MarketInstallSummary {
  id: string;
  name: string;
  version: string;
}

export type MarketInstallOutcome =
  | (MarketInstallSummary & {
      installed: true;
      outcome: 'confirmed';
      manifest: ExtensionManifest;
      /** Where it was installed (its skills are read from there). */
      rootDir: string;
      /** Whether it was the person's to agree to (asked here, or agreed to elsewhere): an agent's answer says more then. */
      asked: boolean;
      updatedFrom?: string;
      /** It is older than the version the market gives this machine: this App is no longer updated by itself (`pinsAutoUpdate`). */
      pinned?: true;
      /** Whether the window was told and drew its tabs (an agent's answer says so; F52). */
      announced: 'shown' | 'pending' | 'failed';
    })
  | (MarketInstallSummary & {
      installed: false;
      outcome: 'ask';
      /** What the sheet shows — the folder it was read from stays here. */
      ask: Omit<ExtensionInstallConsentRequest, 'sourceDir'>;
      /** Whether the person has anything to agree to: false — the caller installs it at once (`given`), as a click is consent. */
      asks: boolean;
    })
  | (MarketInstallSummary & { installed: false; outcome: Exclude<ExtensionInstallConsentResult['outcome'], 'confirmed'> });

/**
 * App 市场 10-07: an App from the market, installed — the one way for every place that installs one (the Apps page, a
 * group's 「用 X 打开」 offer, the first-run set, an agent's `app_install { market }`; 161 10-15: one path, never one per
 * caller). This machine's version of it is fetched, checked against the fingerprint the market recorded and unpacked
 * (`materialize`), read, and installed through the same plan, the same D-30 question and the same consent binding as any
 * install (`installPlan`, the manifest digest), as the market's App (gugu's). Its download progress goes to the window
 * as the Apps page's card draws it (`marketDownloadProgressChannel`).
 */
export async function installExtensionFromMarket(
  install: MarketInstall,
  dependencies: MarketInstallDependencies = {}
): Promise<MarketInstallOutcome> {
  const market = dependencies.market ?? (await import('./market-catalog-root')).cloudExtensionMarket();
  const { extensionId } = install.ref;
  const version = install.ref.version ?? (await offeredVersion(market, extensionId));
  // Agreed to after a `return`: the package kept for it, when this process still has it — the same bytes the person saw.
  const kept = install.consent?.kind === 'given' ? await market.held(extensionId, version) : null;
  let prepared: MarketPrepared | null =
    kept ??
    (await market.materialize(extensionId, version, (received, total) =>
      events.emit(marketDownloadProgressChannel, { extensionId, version, received, total })
    ));
  try {
    const service = extensionsService();
    const { manifest, manifestDigest } = service.inspectDirectory(prepared.sourceDir);
    const summary: MarketInstallSummary = { id: manifest.id, name: manifest.name, version: manifest.version };
    const plan = installPlan(service, manifest, 'market');
    const variant = plan.displaced && service.variants(manifest.id).variants.length > 0 ? { name: 'upstream', base: manifest.version, commit: prepared.source.commit, repo: prepared.source.repo, path: prepared.source.path, dir: null, sha256: prepared.sha256, bytes: prepared.bytes } : undefined;
    if (install.consent?.kind === 'gugu') {
      // Nobody asked: so only gugu's own — the code in its own repository (the bytes were checked against what the market
      // published from there) — and never over an App installed here, whose update asks as any update does. Files with no
      // record of where they came from are an install a start cut off between landing and its record: put in again.
      if (!isGuguOwnApp(prepared.source)) {
        throw new Error(`${manifest.id} is not gugu's own App (its code is at ${prepared.source.repo}); only gugu's own go in without asking`);
      }
      if (plan.displaced && service.origins()[manifest.id] !== undefined) {
        throw new Error(`${manifest.id} is installed here already; it is not put in again without asking`);
      }
      const installed = service.installFromDirectory(prepared.sourceDir, manifestDigest, 'market');
      (dependencies.afterInstall ?? applyInstalledExtension)(installed);
      const announced = await announceInstalledChanged(dependencies.notifyInstalledChanged);
      return { installed: true, outcome: 'confirmed', ...summary, manifest: installed.manifest, rootDir: installed.rootDir, asked: false, announced };
    }
    const consent = install.consent ?? { kind: 'here' as const };
    const done = await installPrepared({
      dir: prepared.sourceDir,
      manifest,
      manifestDigest,
      origin: 'market',
      variant,
      asks: plan.asks,
      // The sheet's first line: from the market, where this version's code is — and what this version changed.
      sheet: { installed: plan.approved, revokedPermissions: plan.revokedPermissions, market: { source: prepared.source, releaseNotes: prepared.releaseNotes } },
      // D-30: a first install of an App giving tools asks which agents get them, every agent here ticked at first; so does
      // installing it for a chat it is not given at yet (125 10-07), that chat ticked.
      places: { first: !plan.displaced, chatId: install.chatId, identity: await (await import('./app-given')).ownInstallIdentity(manifest.id, 'market') },
    }, consent, dependencies);
    if (done.outcome === 'ask') {
      // Kept for the `given` that follows, under its fingerprint: not unpacked here a second time.
      market.hold(prepared);
      prepared = null;
      return { installed: false, ...summary, ...done };
    }
    if (done.outcome !== 'confirmed') return { installed: false, outcome: done.outcome, ...summary };
    // An older version than the market gives this machine, picked by the person (the version history, an agent's `id@version`):
    // it stays as picked — no longer updated by itself — until they switch 「自动更新」 back on.
    const pinned = pinsAutoUpdate(done.installed.manifest.version, (await market.entry(extensionId))?.version ?? null);
    if (pinned) service.setAutoUpdate(extensionId, false);
    return {
      installed: true,
      outcome: 'confirmed',
      ...summary,
      manifest: done.installed.manifest,
      rootDir: done.installed.rootDir,
      asked: done.asked,
      ...(plan.displaced ? { updatedFrom: plan.displaced.manifest.version } : {}),
      ...(pinned ? { pinned: true as const } : {}),
      announced: done.announced,
    };
  } finally {
    // Installed, refused or failed, the unpacked copy is done with; only one handed back for its consent stays.
    if (prepared) market.discard(prepared);
  }
}

/** The version the market gives this machine now (its index taken now: an App published while gugu runs is in it). */
async function offeredVersion(market: Pick<CloudExtensionMarket, 'entry'>, extensionId: string): Promise<string> {
  const entry = await market.entry(extensionId, true);
  if (!entry) throw new Error(`The market has no App "${extensionId}"`);
  return entry.version;
}
