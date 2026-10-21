import type { AppIdentity } from '@shared/extensions/app-identity';
import type { ExtensionInstallConsentRequest, ExtensionInstallConsentResult } from '@shared/extensions/host-actions';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import type { ExtensionOrigin } from '@shared/extensions/upgrade';
import { agreeThenInstall, type InstallConsent } from '@shared/extensions/install-consent-flow';
import type { ExtensionPublisher, InstalledExtension } from './extensions-service';

export type { InstallConsent };
import { applyInstalledExtension } from './extension-after-install';
import { announceInstalledChanged, requestExtensionInstallConsent } from './extension-bridge-relay';
import { extensionsService } from './extensions-root';
import { recordMarketInstall } from './market-ranking';
import { log } from '@main/lib/logger';

/**
 * An App's files, ready here and read (a folder the person or an agent named, a market package fetched and checked, a
 * chat's card downloaded and unpacked) — and what its own source decided about asking. Where they came from is the
 * caller's; from here on every install is the same.
 */
export interface PreparedInstall {
  dir: string;
  manifest: ExtensionManifest;
  manifestDigest: string;
  origin: ExtensionOrigin;
  /** Who published these bytes (app-identity.ts); the market's is gugu's. */
  publisher?: ExtensionPublisher;
  /** Whether installing this asks the person by itself: what it newly declares, or another source replacing one here. */
  asks: boolean;
  /** What the sheet shows of it beyond the manifest: the App it replaces, the grants taken back, where it came from. */
  sheet: Omit<ExtensionInstallConsentRequest, 'sourceDir' | 'manifest' | 'manifestDigest' | 'places'>;
  /** D-30 「给哪些 agent」 is asked of a first install, or of one for a chat it is not given at yet (`installAsk`). */
  places: { first: boolean; chatId?: string; identity: AppIdentity | null; fromCard?: boolean };
}

export interface InstallDependencies {
  requestInstallConsent?: (request: ExtensionInstallConsentRequest) => Promise<ExtensionInstallConsentResult>;
  notifyInstalledChanged?: () => Promise<void>;
  afterInstall?: (installed: InstalledExtension) => void;
}

export type PreparedOutcome =
  | { outcome: 'ask'; ask: Omit<ExtensionInstallConsentRequest, 'sourceDir'>; asks: boolean }
  | { outcome: Exclude<ExtensionInstallConsentResult['outcome'], 'confirmed'> }
  | {
      outcome: 'confirmed';
      installed: InstalledExtension;
      /** Whether it was the person's to agree to (asked here, or agreed to elsewhere). */
      asked: boolean;
      /** Whether the window was told and drew its tabs (an agent's answer says so; F52). */
      announced: 'shown' | 'pending' | 'failed';
    };

/**
 * One install, wherever its files came from (161 10-15: one path, never one per caller): the D-30 question, the consent
 * bound to the manifest digest, the files landed (`installFromDirectory`), where its tools are given recorded before it
 * goes live (a session asking about it reads that), its tabs and programs on, the window told — told, not waited on (F52).
 */
export async function installPrepared(prepared: PreparedInstall, consent: InstallConsent, dependencies: InstallDependencies = {}): Promise<PreparedOutcome> {
  const { manifest, manifestDigest } = prepared;
  const given = await import('./app-given');
  const asked = await given.installAsk(manifest, prepared.places.first, prepared.places.chatId, prepared.places.identity, prepared.places.fromCard);
  const ask: Omit<ExtensionInstallConsentRequest, 'sourceDir'> = { manifest, manifestDigest, ...prepared.sheet, ...(asked ? { places: asked.places } : {}) };
  const asks = prepared.asks || asked !== null;
  const done = await agreeThenInstall(ask, asks, consent, () => (dependencies.requestInstallConsent ?? requestExtensionInstallConsent)({ sourceDir: prepared.dir, ...ask }), async (enableIn) => {
    const installed = extensionsService().installFromDirectory(prepared.dir, manifestDigest, prepared.origin, prepared.publisher);
    await given.recordGiven(installed.manifest.id, asked, enableIn);
    (dependencies.afterInstall ?? applyInstalledExtension)(installed);
    return installed;
  });
  if (done.outcome === 'ask') return { outcome: 'ask', ask, asks };
  if (done.outcome !== 'confirmed') return done;
  // 首页精选按近期安装量排(owner 10-19):一个人第一次从市场装一个 App,记一票。只在这里记 —— 首启默认组、预装走的不是这个函数,
  // 天然不算;卡片、文件夹装的不是市场(owner「按建议」不算)。安装已经成了,记票失败只进日志,❌ 让人重装。
  if (prepared.origin === 'market' && prepared.places.first) {
    void recordMarketInstall(manifest.id).catch((error: unknown) =>
      log.error(`market install not recorded for ${manifest.id}: ${error instanceof Error ? error.message : String(error)}`)
    );
  }
  const announced = await announceInstalledChanged(dependencies.notifyInstalledChanged);
  return { outcome: 'confirmed', installed: done.installed, asked: asks, announced };
}
