import { replaceableFromChat } from './attachment-install';
import { compareExtensionVersions } from './manifest';
import type { ExtensionOrigin } from './upgrade';

/**
 * What an App package's card — or a group's panel — says about that App on this device (摩擦单 F66): one answer, from
 * what is installed here and the newest package of it around, for the desktop and the phone alike. It follows the
 * installed App as it changes: installed, updated, uninstalled (S17: a 0.2.0 card said «Install» to a 0.1.0 install;
 * uninstalled, an old card still said «Open»).
 */

export interface VersionedPackage {
  manifest: { id: string; version: string };
}

/** The newest package of App `id` among these: a group's (F15), the cards on screen (F21), the panel's banner (F66). */
export function newestPackageOf<P extends VersionedPackage>(packages: Iterable<P>, id: string): P | undefined {
  let best: P | undefined;
  for (const pkg of packages) {
    if (pkg.manifest.id === id && (!best || compareExtensionVersions(pkg.manifest.version, best.manifest.version) > 0)) best = pkg;
  }
  return best;
}

export type CardOffer =
  /** Not here: install this card's version — or the newer one around (`newer`), never an older one. */
  | { action: 'install'; version: string; newer: boolean }
  /** An older version is here, from a chat: update it to the newest around. */
  | { action: 'update'; version: string }
  /**
   * An older version is here that did not come from a chat (the market's, gugu's own, a folder's — E-05): a package from
   * chat cannot replace it, so no update is offered — what is here is said (`from`, none when its origin was never kept).
   */
  | { action: 'elsewhere'; installedVersion: string; from: ExtensionOrigin | undefined }
  /** This version or a later one is here: open it (`installedNewer`: the later one here, said — never a downgrade). */
  | { action: 'open'; installedNewer: string | null };

export function cardOffer(args: {
  installedVersion: string | null;
  /** Where the installed one came from; read only when one is installed. */
  installedOrigin: ExtensionOrigin | undefined;
  cardVersion: string;
  newestVersion?: string;
}): CardOffer {
  const { installedVersion, installedOrigin, cardVersion, newestVersion } = args;
  const wanted = newestVersion !== undefined && compareExtensionVersions(newestVersion, cardVersion) > 0 ? newestVersion : cardVersion;
  if (installedVersion === null) return { action: 'install', version: wanted, newer: wanted !== cardVersion };
  if (compareExtensionVersions(installedVersion, wanted) < 0) {
    return replaceableFromChat(installedOrigin) ? { action: 'update', version: wanted } : { action: 'elsewhere', installedVersion, from: installedOrigin };
  }
  return { action: 'open', installedNewer: compareExtensionVersions(installedVersion, cardVersion) > 0 ? installedVersion : null };
}

/**
 * The group's newer package of an App installed here (the panel's banner, F66); null when what is here is as new, or did
 * not come from a chat — a package from chat cannot replace that one (E-05).
 */
export function groupUpdateFor<P extends VersionedPackage>(
  installed: { version: string; origin: ExtensionOrigin | undefined } | null,
  newest: P | undefined
): P | null {
  return installed !== null && replaceableFromChat(installed.origin) && newest !== undefined && compareExtensionVersions(newest.manifest.version, installed.version) > 0
    ? newest
    : null;
}
