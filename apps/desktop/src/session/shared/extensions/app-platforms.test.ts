import { describe, expect, it } from 'vitest';
import { appPlatformProblems, PHONE_CAPABILITIES, PHONE_CAPABILITY_SUPPORT, requireAppPlatform } from './app-platforms';
import { EXTENSION_CAPABILITIES, safeParseExtensionManifest } from './manifest';
import { marketEntriesFrom, marketHistoryFrom, marketUpdatesFrom } from './market-entries';
import { currentMarketHost, type MarketIndexApp } from './market';

const manifest = (version = '1.0.0', platforms?: ('desktop' | 'phone')[]) => ({
  id: 'reader', name: 'Reader', version, apiVersion: platforms ? 11 : 3,
  ...(platforms ? { platforms } : {}),
  entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Reader' }] },
});
const row = (version: string, platforms?: ('desktop' | 'phone')[]): MarketIndexApp['versions'][number] => ({
  version, manifest: manifest(version, platforms), apiVersion: platforms ? 11 : 3, minAppVersion: '0.2.57',
  releaseNotes: '', publishedAt: '2026-10-24', sha256: 'a'.repeat(64), bytes: 100, bundle: 'bundle.zip',
  icon: null, readme: null, source: { repo: 'author/reader', path: '.', commit: 'a'.repeat(40) }, yanked: null,
});
const app = (versions: MarketIndexApp['versions']): MarketIndexApp => ({ id: 'reader', deprecated: null, versions });

describe('App platform boundaries', () => {
  it('keeps an installed old App readable but refuses it as a new installation', () => {
    expect(safeParseExtensionManifest(manifest())).toMatchObject({ ok: true });
    expect(currentMarketHost('0.2.58', 'desktop')).toMatchObject({ apiVersionMin: 3, apiVersionMax: 11 });
    expect(() => requireAppPlatform(manifest(), 'desktop')).toThrow('declare desktop, phone, or both');
  });

  it('distinguishes phone agent features from an unavailable human capability, using every capability once', () => {
    expect(Object.keys(PHONE_CAPABILITY_SUPPORT).sort()).toEqual([...EXTENSION_CAPABILITIES].sort());
    expect(PHONE_CAPABILITIES).toEqual(['files:read', 'files:read:all-machines', 'files:write', 'chat:relay', 'chat:read']);
    expect(appPlatformProblems({ ...manifest('1.0.0', ['phone']), permissions: { capabilities: ['agents:tools'] } })).toEqual([]);
    expect(appPlatformProblems({ ...manifest('1.0.0', ['phone']), permissions: { capabilities: ['notifications'] } })).toContain('platforms: phone does not support notifications');
    expect(appPlatformProblems({ ...manifest('1.0.0', ['desktop']), permissions: { capabilities: ['notifications'] } })).toEqual([]);
  });

  it('refuses empty, duplicate, unknown and incorrectly versioned declarations', () => {
    for (const platforms of [[], ['desktop', 'desktop'], ['tablet']]) {
      expect(appPlatformProblems({ ...manifest(), apiVersion: 11, platforms }).length).toBeGreaterThan(0);
    }
    expect(appPlatformProblems({ ...manifest('1.0.0', ['phone']), apiVersion: 10 })).toContain('platforms: requires apiVersion 11');
  });

  it('selects the newest phone version before API compatibility and does not offer desktop-only updates', () => {
    const versions = [row('0.9.0'), row('1.0.0', ['desktop', 'phone']), row('2.0.0', ['desktop'])];
    const phone = currentMarketHost('0.2.58', 'phone');
    const index = { apps: [app(versions)] };
    expect(marketEntriesFrom(index.apps, phone, (path) => path).extensions[0]?.version).toBe('1.0.0');
    expect(marketEntriesFrom(index.apps, currentMarketHost('0.2.58', 'desktop'), (path) => path).extensions[0]?.version).toBe('2.0.0');
    expect(marketUpdatesFrom(index, phone, [{ id: 'reader', version: '1.0.0', fromMarket: true }], '').updates).toEqual({});
    expect(marketHistoryFrom(index.apps[0]!, phone)[0]?.platformRefusal).toContain('does not support phone');
    expect(marketEntriesFrom([app([row('0.9.0')])], phone, (path) => path).extensions).toEqual([]);
  });

  it('leaves an unknown future API capability to version compatibility when reading the market', () => {
    const future = {
      ...row('2.0.0', ['phone']), apiVersion: 12,
      manifest: { ...manifest('2.0.0', ['phone']), apiVersion: 12, permissions: { capabilities: ['future:capability'] } },
    };
    const phone = currentMarketHost('0.2.58', 'phone');
    expect(marketEntriesFrom([app([row('1.0.0', ['phone']), future])], phone, (path) => path).extensions[0])
      .toMatchObject({ version: '1.0.0', newerNeedsApp: '2.0.0' });
    expect(marketEntriesFrom([app([future])], phone, (path) => path).extensions[0])
      .toMatchObject({ version: '2.0.0', compat: { reason: 'needs-newer-app' } });
  });
});
