import { describe, expect, it } from 'vitest';
import { cardOffer, groupUpdateFor, newestPackageOf } from './app-card-state';
import { compareExtensionVersions } from './manifest';

/**
 * 摩擦单 F66 (L6 S17): B had 0.1.0; a 0.2.0 card came into the group and said «Install», B's open 0.1.0 page said nothing;
 * uninstalled, the old card still said «Open». The card's offer now follows what is installed here, every time, and a
 * group's newer package of an installed App is named — one answer for the desktop and the phone.
 */

/** The card's decision before F66 (ExtensionBundleCard at 72903ae18), for the control cells. */
function before(args: { installedVersion: string | null; cardVersion: string; newestVersion?: string; clickedInstall?: boolean }): string {
  const newer = args.newestVersion && compareExtensionVersions(args.newestVersion, args.cardVersion) > 0 ? args.newestVersion : null;
  const wanted = newer ?? args.cardVersion;
  const installed = args.clickedInstall === true || (args.installedVersion !== null && compareExtensionVersions(args.installedVersion, wanted) >= 0);
  return installed ? 'open' : newer ? 'install-newer' : 'install';
}

/** The card's and the bar's decision before E-05 was read (app-card-state.ts at 6cdb28be80): by version alone. */
function versionAlone(args: { installedVersion: string; cardVersion: string }): 'update' | 'open' {
  return compareExtensionVersions(args.installedVersion, args.cardVersion) < 0 ? 'update' : 'open';
}

describe('what a card offers here (摩擦单 F66)', () => {
  it('0.1.0 installed, a 0.2.0 card: update to 0.2.0 — control: it said «Install»', () => {
    expect(cardOffer({ installedOrigin: 'attachment', installedVersion: '0.1.0', cardVersion: '0.2.0' })).toEqual({ action: 'update', version: '0.2.0' });
    expect(before({ installedVersion: '0.1.0', cardVersion: '0.2.0' })).toBe('install');
  });

  it('the old 0.1.0 card, with 0.1.0 installed and 0.2.0 around: update to 0.2.0 — control: «install it»', () => {
    expect(cardOffer({ installedOrigin: 'attachment', installedVersion: '0.1.0', cardVersion: '0.1.0', newestVersion: '0.2.0' })).toEqual({ action: 'update', version: '0.2.0' });
    expect(before({ installedVersion: '0.1.0', cardVersion: '0.1.0', newestVersion: '0.2.0' })).toBe('install-newer');
  });

  it('uninstalled after the card installed it: install — control: the card had kept «Open»', () => {
    expect(cardOffer({ installedOrigin: 'attachment', installedVersion: null, cardVersion: '0.2.0' })).toEqual({ action: 'install', version: '0.2.0', newer: false });
    expect(before({ installedVersion: null, cardVersion: '0.2.0', clickedInstall: true })).toBe('open');
  });

  it('not here: install this version, or the newer one around; never an older one', () => {
    expect(cardOffer({ installedOrigin: 'attachment', installedVersion: null, cardVersion: '0.1.0', newestVersion: '0.2.0' })).toEqual({ action: 'install', version: '0.2.0', newer: true });
    expect(cardOffer({ installedOrigin: 'attachment', installedVersion: null, cardVersion: '0.2.0', newestVersion: '0.1.0' })).toEqual({ action: 'install', version: '0.2.0', newer: false });
  });

  // 10-17 (群文件夹图标车道,mac1): the market's office 0.1.1 here, a 0.1.2 card said 「更新到 0.1.2」 and the install
  // refused it (E-05). It now says what is here instead. Control: the decision before (by version alone) said update.
  it('E-05: an older App here that did not come from a chat is said, not offered an update — control: it said update', () => {
    for (const origin of ['market', 'preinstalled', 'folder', undefined] as const) {
      expect(cardOffer({ installedVersion: '0.1.1', installedOrigin: origin, cardVersion: '0.1.2' })).toEqual({ action: 'elsewhere', installedVersion: '0.1.1', from: origin });
      expect(cardOffer({ installedVersion: '0.1.1', installedOrigin: origin, cardVersion: '0.1.1', newestVersion: '0.1.2' })).toEqual({ action: 'elsewhere', installedVersion: '0.1.1', from: origin });
      expect(versionAlone({ installedVersion: '0.1.1', cardVersion: '0.1.2' })).toBe('update');
    }
    // Not older: it opens, whatever its origin — nothing is replaced.
    expect(cardOffer({ installedVersion: '0.1.2', installedOrigin: 'market', cardVersion: '0.1.2' })).toEqual({ action: 'open', installedNewer: null });
    expect(cardOffer({ installedVersion: '0.1.3', installedOrigin: 'market', cardVersion: '0.1.2' })).toEqual({ action: 'open', installedNewer: '0.1.3' });
  });

  it('this version or later here: open — a later one is said, never a downgrade', () => {
    expect(cardOffer({ installedOrigin: 'attachment', installedVersion: '0.2.0', cardVersion: '0.2.0' })).toEqual({ action: 'open', installedNewer: null });
    expect(cardOffer({ installedOrigin: 'attachment', installedVersion: '0.3.0', cardVersion: '0.2.0', newestVersion: '0.2.0' })).toEqual({ action: 'open', installedNewer: '0.3.0' });
  });
});

describe("the group's newest package (F15 / F21 / F66: one function)", () => {
  const pkg = (id: string, version: string, url: string) => ({ manifest: { id, version }, url });

  it('the highest version of that App; others ignored; the first of equals kept', () => {
    const packages = [pkg('vote', '0.1.0', 'a'), pkg('vote', '0.2.0', 'b'), pkg('draw', '9.0.0', 'c'), pkg('vote', '0.2.0', 'd')];
    expect(newestPackageOf(packages, 'vote')?.url).toBe('b');
    expect(newestPackageOf(packages, 'none')).toBeUndefined();
  });

  it('an update for the panel only when what is here is older; nothing when not installed (that is the F15 offer)', () => {
    const newest = pkg('vote', '0.2.0', 'b');
    const fromChat = (version: string) => ({ version, origin: 'attachment' as const });
    expect(groupUpdateFor(fromChat('0.1.0'), newest)?.url).toBe('b');
    expect(groupUpdateFor(fromChat('0.2.0'), newest)).toBeNull();
    expect(groupUpdateFor(fromChat('0.3.0'), newest)).toBeNull();
    expect(groupUpdateFor(null, newest)).toBeNull();
    expect(groupUpdateFor(fromChat('0.1.0'), undefined)).toBeNull();
  });

  // 10-17 (群文件夹图标车道,mac1):the market's office 0.1.1 here, a 0.1.2 package in the group — the bar offered 「更新」
  // and the install refused it (E-05). Control: by version alone (the bar's decision before) it was offered for every origin.
  it('E-05: no update bar over an App that did not come from a chat — control: by version alone it was offered', () => {
    const newest = pkg('office', '0.1.2', 'b');
    for (const origin of ['market', 'preinstalled', 'folder', undefined] as const) {
      expect(groupUpdateFor({ version: '0.1.1', origin }, newest)).toBeNull();
      expect(versionAlone({ installedVersion: '0.1.1', cardVersion: newest.manifest.version })).toBe('update');
    }
  });
});
