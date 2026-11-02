import type { ExtensionManifest } from '@shared/extensions/manifest';
import { installAsks } from '@shared/extensions/upgrade';
import type { ExtensionsService } from './extensions-service';

/**
 * Whether installing this asks the person, and what it newly declares, read off what is installed here — for every
 * install main lands from a folder or the market: an agent's `app_create` / `app_install`, and the market's
 * (`installExtensionFromMarket`: the Apps page, a group's offer, the first-run set, an agent's `app_install { market }`).
 * The rule itself is shared with the phone (upgrade.ts `installAsks`).
 */
export function installPlan(service: ExtensionsService, manifest: ExtensionManifest, origin: 'folder' | 'market' | 'fork' = 'folder') {
  const displaced = service.list().extensions.find((entry) => entry.manifest.id === manifest.id);
  // One written for an older interface is replaced as any installed App is: by what the person approved of it.
  const older = displaced ? null : service.olderInterface(manifest.id);
  const revokedPermissions = displaced || older ? service.revokedPermissions(manifest.id) : [];
  const approved = displaced ? service.approvedManifest(manifest.id) : older ? { version: older.version, permissions: older.permissions } : undefined;
  const { newlyAsked, asks } = installAsks({
    installed: approved,
    installedOrigin: displaced || older ? service.origins()[manifest.id] : undefined,
    revokedPermissions,
    candidate: manifest,
    origin,
  });
  return { displaced, approved, revokedPermissions, newlyAsked, asks };
}
