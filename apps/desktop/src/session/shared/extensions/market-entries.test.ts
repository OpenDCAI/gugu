import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import apiIndex from './fixtures/app-api-index.json';
import { compatOf, currentMarketHost, firstReleaseFor, marketCompatText } from './market';
import { parseMarketIndex } from './market-snapshot';
import { marketHome } from './market-home';
import { describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION } from './manifest';
import type { MarketIndexVersion } from './market';
import { autoUpdatesFrom, marketEntriesFrom, marketUpdatesFrom, pinsAutoUpdate } from './market-entries';

// owner 10-19 (market Apps update by themselves, as VS Code's do): which version each App goes to, and when installing one
// pins it. Shared by main (auto-update-apps.ts) and the phone (phoneApps.ts).
const summary = (parts: Partial<Parameters<typeof autoUpdatesFrom>[0]>) => ({ checkedAt: '', updates: {}, yanked: {}, deprecated: {}, ...parts });

describe('autoUpdatesFrom', () => {
  it("goes to the market's version when it is newer, a withdrawn one's replacement included", () => {
    const s = summary({
      updates: { radar: { version: '1.1.0', releaseNotes: '' } },
      yanked: { office: { reason: 'broke', installable: '0.3.0' } },
    });
    expect(autoUpdatesFrom(s, [{ id: 'radar', version: '1.0.0' }, { id: 'office', version: '0.2.0' }])).toEqual([
      { id: 'radar', from: '1.0.0', version: '1.1.0' },
      { id: 'office', from: '0.2.0', version: '0.3.0' },
    ]);
  });

  it('never back to an older version, and not for an App left out by the caller', () => {
    const s = summary({ updates: { radar: { version: '1.1.0', releaseNotes: '' } }, yanked: { office: { reason: 'broke', installable: '0.1.0' } } });
    expect(autoUpdatesFrom(s, [{ id: 'office', version: '0.2.0' }])).toEqual([]);
    expect(autoUpdatesFrom(s, [])).toEqual([]);
  });
});

describe('pinsAutoUpdate', () => {
  it('pins an older version than the one offered; not the offered one, nor one the market does not offer', () => {
    expect(pinsAutoUpdate('1.0.0', '1.1.0')).toBe(true);
    expect(pinsAutoUpdate('1.1.0', '1.1.0')).toBe(false);
    expect(pinsAutoUpdate('1.0.0', null)).toBe(false);
  });
});

describe('marketUpdatesFrom: an App no longer in the market', () => {
  it('one installed from the market and absent from the index is gone; one from a folder or a chat never was in it', () => {
    const host = { platform: 'desktop' as const, appVersion: '0.2.60', apiVersionMin: 1, apiVersionMax: 99 };
    const told = marketUpdatesFrom({ apps: [] }, host, [{ id: 'radar', version: '1.0.0', fromMarket: true }, { id: 'mine', version: '0.1.0', fromMarket: false }], '');
    expect(told.gone).toEqual(['radar']);
    expect(told.updates).toEqual({});
  });
});


it('reports a fork falling behind without offering it an automatic replacement, and keeps upstream deprecation', () => {
  const host = { platform: 'desktop' as const, appVersion: '0.2.60', apiVersionMin: 1, apiVersionMax: 99 };
  const versions = ['1.0.0', '1.1.0', '1.2.0'].map((version, i) => ({ version, apiVersion: EXTENSION_API_VERSION, minAppVersion: '0.1.0',
    manifest: { id: 'radar', name: 'Radar', version, apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Radar' }] } },
    source: { repo: 'owner/repo', path: '.', commit: String(i).repeat(40) }, yanked: i === 1 ? { reason: 'withdrawn' } : null }) as MarketIndexVersion);
  const deprecated = { note: 'No longer maintained', replacedBy: null };
  const index = { apps: [{ id: 'radar', deprecated, versions }] };
  expect(marketUpdatesFrom(index, host, [{ id: 'radar', version: '1.0.0', fromMarket: true }], '').updates.radar?.version).toBe('1.2.0');
  const result = marketUpdatesFrom(index, host, [{ id: 'radar', version: '1.0.0', forkBase: '1.0.0' }], '');
  expect(result.forkBehind).toEqual({ radar: { upstream: '1.2.0', behind: 1, commit: '2'.repeat(40) } });
  expect(result.updates).toEqual({});
  expect(result.yanked).toEqual({});
  expect(result.deprecated).toEqual({ radar: deprecated });
});

// Published index fixture, retaining the original apps/versions shape and Data Lens versions.
const h25 = { platform: 'desktop' as const, appVersion: '0.3.1-beta.1133.1', apiVersionMin: 25, apiVersionMax: 25 };
const api26 = { apiVersion: 26, minAppVersion: '0.3.1' };

describe('App API prompt contract', () => {
  it('A1 carries the API that refused, never the manifest semver floor', () => {
    const index = parseMarketIndex(JSON.stringify(apiIndex));
    const lens = marketEntriesFrom(index.apps, h25, path => path).extensions[0]!;
    expect(lens.version).toBe('0.1.1');
    expect(lens.compat).toMatchObject({ reason: 'needs-newer-app', gate: 'api', apiVersion: 26, firstRelease: null });
    expect(lens.compat).not.toHaveProperty('minAppVersion');
  });
  it('A2 reads the beta release from the optional index table', () => {
    const index = parseMarketIndex(JSON.stringify({ ...apiIndex, hostApi: [{ apiVersion: 26, firstRelease: { beta: '0.3.1-beta.1134.1' } }] }));
    const lens = marketEntriesFrom(index.apps, h25, path => path, index.hostApi).extensions[0]!;
    expect(lens.compat).toMatchObject({ gate: 'api', apiVersion: 26, firstRelease: '0.3.1-beta.1134.1' });
  });
  it.each([null, 'broken', [{ apiVersion: '26', firstRelease: { beta: false } }]])('A3 malformed optional table %j leaves the list usable', hostApi => {
    const index = parseMarketIndex(JSON.stringify({ ...apiIndex, hostApi }));
    const lens = marketEntriesFrom(index.apps, h25, path => path, index.hostApi).extensions[0]!;
    expect(lens.compat).toMatchObject({ gate: 'api', apiVersion: 26, firstRelease: null });
  });
  it('A4 and A5 preserve semver and author-update refusals', () => {
    expect(compatOf({ apiVersion: 25, minAppVersion: '0.3.2' }, h25)).toMatchObject({ reason: 'needs-newer-app', minAppVersion: '0.3.2' });
    expect(compatOf({ apiVersion: 24, minAppVersion: '0.1.0' }, h25)).toEqual({ reason: 'needs-author-update', apiVersion: 24 });
  });
  it('A8 every existing text surface uses the shared compatibility wording', () => {
    const readers = [
      'apps/desktop/src/components/settings/AppsSection.tsx',
      'apps/desktop/src/session/renderer/features/extensions/panel/app-lifecycle.ts',
      'apps/desktop/src/session/renderer/features/extensions/panel/app-market-content.tsx',
      'apps/desktop/src/session/renderer/features/extensions/panel/app-product-page.tsx',
      'apps/desktop/src/components/appSlot/phoneMarket.ts',
      'apps/desktop/src/components/extensionBundle/ExtensionBundleCard.tsx',
      'apps/desktop/electron/session/main/core/extensions/market-catalog.ts',
    ];
    for (const file of readers) {
      const text = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(text, file).toContain('marketCompatText');
      expect(text, file).not.toMatch(/compat\.minAppVersion/);
    }
  });
  it.each([false, true])('A9 keeps the original index card on home (featured=%s), while retired/author-update stay hidden', featured => {
    const index = parseMarketIndex(JSON.stringify(apiIndex));
    const lens = { ...marketEntriesFrom(index.apps, h25, path => path).extensions[0]!, featured };
    const old = { ...lens, manifest: { ...lens.manifest, id: 'old-interface' }, compat: { reason: 'needs-author-update' as const, apiVersion: 24 } };
    const retired = { ...lens, manifest: { ...lens.manifest, id: 'retired' }, deprecated: { note: null, replacedBy: null } };
    const home = marketHome([lens, old, retired], null);
    expect([...home.featured, ...home.remaining].map(entry => entry.manifest.id)).toEqual(['data-lens']);
    expect(lens.compat).toMatchObject({ reason: 'needs-newer-app', gate: 'api', apiVersion: 26 });
    const popular = marketHome([lens, old, retired], new Map([['data-lens', 2], ['old-interface', 3], ['retired', 4]]));
    expect(popular.popular?.map(entry => entry.manifest.id)).toEqual(['data-lens']);
  });
});

it('reverse release lookup is channel-specific, chooses the smallest sufficient API, and never decides eligibility', () => {
  const hostApi = [
    { apiVersion: 29, firstRelease: { beta: '0.3.1-beta.2000.1', stable: '0.3.3' } },
    { apiVersion: 26, firstRelease: { beta: '0.3.1-beta.1134.1' } },
    { apiVersion: 27, firstRelease: { stable: '0.3.2' } },
  ];
  expect(currentMarketHost('0.3.1-beta.1133.1', 'desktop').channel).toBe('beta');
  expect(currentMarketHost('0.3.1', 'phone').channel).toBe('stable');
  expect(firstReleaseFor(hostApi, 26, 'beta')).toBe('0.3.1-beta.1134.1');
  expect(firstReleaseFor(hostApi, 26, 'stable')).toBe('0.3.2');
  expect(firstReleaseFor(hostApi, 30, 'stable')).toBeNull();
  expect(firstReleaseFor([{ apiVersion: 26, firstRelease: { beta: 'not-a-version' } }], 26, 'beta')).toBeNull();
  const api = compatOf(api26, h25)!;
  expect(marketCompatText(api)).toContain('App API 26');
  expect(marketCompatText(api)).not.toContain('0.3.1');
  expect(marketCompatText(compatOf(api26, h25, hostApi)!)).toContain('0.3.1-beta.1134.1');
  expect(marketCompatText(api, (key, values) => `${key}:${values?.apiVersion ?? ''}`)).toBe('extensions.needsAppApi:26');
});
