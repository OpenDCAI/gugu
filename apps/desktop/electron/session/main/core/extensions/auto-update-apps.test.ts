import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION, EXTENSION_API_VERSION_MIN_SUPPORTED } from '@shared/extensions/manifest';
import type { MarketIndexVersion } from '@shared/extensions/market';
import { ExtensionsService } from './extensions-service';
import { packExtensionArchive } from './extension-archive';
import { CloudExtensionMarket, type BundleDownloadOptions, type MarketBackend } from './market-catalog';

// owner 10-19: market Apps update by themselves, as VS Code's do; an older version the person picked stays (VS Code's pinned).
// Run over the real service, the real market over a test download site, and the one install path.
const state = vi.hoisted(() => ({ service: null as unknown, userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));
vi.mock('./extensions-root', () => ({ extensionsService: () => state.service }));

const { autoUpdateAppsOnce } = await import('./auto-update-apps');
const { installExtensionFromMarket } = await import('./extension-market-install');
const { events } = await import('@main/lib/events');
vi.spyOn(events, 'emit').mockImplementation(() => undefined as never);

const source = { repo: 'shuxueshuxue/gugu-apps', path: 'sources/radar', commit: 'c'.repeat(40) };
const quiet = { afterInstall: () => {}, notifyInstalledChanged: async () => {} };
let work: string;
let service: ExtensionsService;

class Site implements MarketBackend {
  downloads: string[] = [];
  index: { apps: unknown[] } = { apps: [] };
  bundles: Record<string, Uint8Array> = {};
  readText(relativePath: string): Promise<string> {
    if (relativePath !== 'index.json') return Promise.reject(new Error(`HTTP 404 ${relativePath}`));
    return Promise.resolve(JSON.stringify(this.index));
  }
  download(relativePath: string, options: BundleDownloadOptions): Promise<Uint8Array> {
    this.downloads.push(relativePath);
    const bytes = this.bundles[relativePath];
    if (!bytes) return Promise.reject(new Error(`HTTP 404 ${relativePath}`));
    options.onProgress?.(bytes.byteLength);
    return Promise.resolve(bytes);
  }
  urlOf(relativePath: string): string {
    return `https://download.test/market/${relativePath}`;
  }
}

let site: Site;
let market: CloudExtensionMarket;

/** One version of `radar` packed and its row; `network` is what it asks for. */
async function version(v: string, options: { network?: string[]; yanked?: string } = {}): Promise<MarketIndexVersion> {
  const dir = path.join(work, 'src', `radar-${v}`);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    id: 'radar', name: 'Radar', version: v, apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
    ...(options.network ? { permissions: { network: options.network } } : {}), contributes: { tabs: [{ name: 'main', title: 'Radar' }] },
  };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(path.join(dir, 'index.html'), `<!doctype html><title>${v}</title>`);
  const { bytes, sha256 } = await packExtensionArchive(service, dir);
  const bundle = `bundles/radar/${v}.zip`;
  site.bundles[bundle] = new Uint8Array(bytes);
  return {
    version: v, manifest, apiVersion: EXTENSION_API_VERSION, minAppVersion: '0.1.0', releaseNotes: `v${v}`,
    publishedAt: '2026-10-19T00:00:00Z', sha256, bytes: bytes.byteLength, bundle, icon: null, source,
    yanked: options.yanked ? { reason: options.yanked } : null,
  };
}

/** The index now lists these versions, and the market has taken it (as opening the 「App」 page does). */
async function publish(rows: MarketIndexVersion[]): Promise<void> {
  site.index = { apps: [{ id: 'radar', deprecated: null, versions: rows }] };
  await market.refresh();
}

const install = (v: string) => installExtensionFromMarket({ ref: { extensionId: 'radar', version: v } }, { ...quiet, market });
const installed = () => service.get('radar').manifest.version;

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'gugu-auto-update-'));
  state.userData = path.join(work, 'userData');
  service = new ExtensionsService(path.join(state.userData, 'task-extensions'));
  state.service = service;
  site = new Site();
  market = new CloudExtensionMarket(site, {
    stagingRoot: path.join(state.userData, 'extension-market', 'staging'),
    heldRoot: path.join(state.userData, 'extension-market', 'held'),
    resolveHost: async () => ({ platform: 'desktop' as const, appVersion: '0.2.60', apiVersionMin: EXTENSION_API_VERSION, apiVersionMax: EXTENSION_API_VERSION }),
    snapshotStore: { read: async () => null, write: async () => undefined },
  });
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('market Apps update by themselves (autoUpdateAppsOnce)', () => {
  // App 模型 v2 (owner 10-31: one switch, no compatibility layer): an App from the market written for the interface before
  // does not run here, and goes to the market's version for this one by itself — asking only for what that version adds.
  it('moves an installed App written for the older interface to the market version this build runs', async () => {
    const previous = await version('1.0.0');
    await publish([previous]);
    await install('1.0.0');
    // A profile written by the previous client: its manifest as apiVersion 22 wrote it.
    const { defaultLocale: _locale, ...current } = service.get('radar').manifest;
    const old = { ...current, apiVersion: EXTENSION_API_VERSION_MIN_SUPPORTED - 1, description: 'Watches agents.' };
    writeFileSync(path.join(service.get('radar').rootDir, 'manifest.json'), JSON.stringify(old));
    expect(service.list().invalid.map((entry) => entry.dirName)).toEqual(['radar']);
    expect(service.olderInterface('radar')).toMatchObject({ id: 'radar', version: '1.0.0' });
    await publish([previous, await version('1.1.0')]);

    await expect(autoUpdateAppsOnce({ ...quiet, market })).resolves.toEqual([{ id: 'radar', from: '1.0.0', version: '1.1.0' }]);
    expect(service.get('radar').manifest).toMatchObject({ apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', version: '1.1.0' });
    expect(service.list().invalid).toEqual([]);
  });

  it('puts in the newer version the market gives this machine, without asking, fetched once', async () => {
    const v1 = await version('1.0.0');
    await publish([v1]);
    await install('1.0.0');
    await publish([v1, await version('1.1.0')]);
    site.downloads = [];

    await expect(autoUpdateAppsOnce({ ...quiet, market })).resolves.toEqual([{ id: 'radar', from: '1.0.0', version: '1.1.0' }]);
    expect(installed()).toBe('1.1.0');
    expect(service.origins().radar).toBe('market');
    expect(site.downloads).toEqual(['bundles/radar/1.1.0.zip']);
    // Nothing newer: a second pass does nothing.
    await expect(autoUpdateAppsOnce({ ...quiet, market })).resolves.toEqual([]);
  });

  it('leaves one whose 「自动更新」 is off, and one switched off', async () => {
    const v1 = await version('1.0.0');
    await publish([v1]);
    await install('1.0.0');
    await publish([v1, await version('1.1.0')]);

    service.setAutoUpdate('radar', false);
    await expect(autoUpdateAppsOnce({ ...quiet, market })).resolves.toEqual([]);
    service.setAutoUpdate('radar', true);
    service.setEnabled('radar', false);
    await expect(autoUpdateAppsOnce({ ...quiet, market })).resolves.toEqual([]);
    expect(installed()).toBe('1.0.0');
    // Control: on and enabled, the same App is updated.
    service.setEnabled('radar', true);
    await expect(autoUpdateAppsOnce({ ...quiet, market })).resolves.toHaveLength(1);
    expect(installed()).toBe('1.1.0');
  });

  it('a version asking for more waits for the person — not put in, not even downloaded', async () => {
    const v1 = await version('1.0.0');
    await publish([v1]);
    await install('1.0.0');
    await publish([v1, await version('1.1.0', { network: ['api.example.com'] })]);
    site.downloads = [];

    await expect(autoUpdateAppsOnce({ ...quiet, market })).resolves.toEqual([]);
    expect(installed()).toBe('1.0.0');
    expect(site.downloads).toEqual([]);
  });

  it('from a withdrawn version to a newer one, never back to an older one', async () => {
    const v1 = await version('1.0.0');
    const v11 = await version('1.1.0');
    await publish([v1, v11]);
    await install('1.1.0');
    await publish([v1, { ...v11, yanked: { reason: 'broke the chart' } }]);
    await expect(autoUpdateAppsOnce({ ...quiet, market })).resolves.toEqual([]);
    expect(installed()).toBe('1.1.0');

    await publish([v1, { ...v11, yanked: { reason: 'broke the chart' } }, await version('1.2.0')]);
    await expect(autoUpdateAppsOnce({ ...quiet, market })).resolves.toEqual([{ id: 'radar', from: '1.1.0', version: '1.2.0' }]);
  });
});

describe('an older version picked stays (VS Code pins it)', () => {
  it('installing an older version than the market gives this machine switches its 「自动更新」 off; the newest does not', async () => {
    const v1 = await version('1.0.0');
    await publish([v1, await version('1.1.0')]);

    await expect(install('1.0.0')).resolves.toMatchObject({ installed: true, pinned: true });
    expect(service.autoUpdateOffIds()).toEqual(['radar']);
    await expect(autoUpdateAppsOnce({ ...quiet, market })).resolves.toEqual([]);
    expect(installed()).toBe('1.0.0');

    // 「更新」 pressed: the newest goes in, and it stays off (VS Code: still pinned after Update).
    await expect(install('1.1.0')).resolves.not.toHaveProperty('pinned');
    expect(service.autoUpdateOffIds()).toEqual(['radar']);

    // Control: a first install of the newest is not pinned.
    service.uninstall('radar');
    expect(service.autoUpdateOffIds()).toEqual([]);
    await install('1.1.0');
    expect(service.autoUpdateOffIds()).toEqual([]);
  });
});
