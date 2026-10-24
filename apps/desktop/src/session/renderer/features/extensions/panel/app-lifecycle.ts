import { shelfRelation } from '@shared/extensions/catalog';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import type { MarketListItem } from '@shared/extensions/market';
import type { SessionTranslate } from '../extension-consent';
import type { AppLifecycle } from './app-lifecycle-button';

/** One lifecycle for every market surface; hosts supply their inventory and ability to open a page. */
export function appLifecycle({ installed, enabled, updateVersion, offered, preinstalled, canOpen }: {
  installed?: ExtensionManifest;
  enabled: boolean;
  updateVersion?: string;
  offered?: Pick<MarketListItem, 'manifest' | 'cloud'>;
  preinstalled: boolean;
  canOpen: boolean;
}, translate: SessionTranslate): AppLifecycle {
  if (!installed) {
    if (!offered) return null;
    const compat = offered.cloud.compat;
    if (compat) return {
      kind: 'word',
      text: compat.reason === 'needs-newer-app' ? translate('extensions.needsNewerApp', { version: compat.minAppVersion }) : translate('extensions.needsAuthorUpdate'),
      title: translate('extensions.compatExplain'),
    };
    return { kind: 'get' };
  }
  if (!enabled) return { kind: 'enable' };
  if (updateVersion) return { kind: 'update', version: updateVersion };
  if (offered && !offered.cloud.compat && !preinstalled && shelfRelation(offered.manifest, installed) === 'installed-older') {
    return { kind: 'update', version: offered.manifest.version };
  }
  return canOpen ? { kind: 'open' } : { kind: 'word', text: translate('extensions.installedMark') };
}
