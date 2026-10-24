import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import type { MarketIndexVersion } from '@shared/extensions/market';
import { ExtensionsService } from './extensions-service';
import { packExtensionArchive } from './extension-archive';
import { CloudExtensionMarket, type BundleDownloadOptions, type MarketBackend } from './market-catalog';

// An App from the market, installed the one way every place installs one (161 10-15): the Apps page, a group's offer, the
// first-run set, an agent's app_install { market }. Main fetches, checks and unpacks it, asks — or hands the ask back and
// installs the very bytes the person agreed to, fetched once.
const state = vi.hoisted(() => ({ service: null as unknown, userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));
vi.mock('./extensions-root', () => ({ extensionsService: () => state.service }));

const { installExtensionFromMarket } = await import('./extension-market-install');
const { events } = await import('@main/lib/events');
// The card's 「下载中 42%」 is drawn from these; here they are only read (there is no window).
const progress = vi.spyOn(events, 'emit').mockImplementation(() => undefined as never);

const source = { repo: 'shuxueshuxue/gugu-apps', path: 'sources/share', commit: 'c'.repeat(40) };
const quiet = { afterInstall: () => {}, notifyInstalledChanged: async () => {} };
let work: string;
let service: ExtensionsService;

/** The download site: one index, the bundles it names; every bundle fetched is counted. */
class Site implements MarketBackend {
  downloads = 0;
  constructor(public index: { apps: unknown[] }, private readonly bundles: Record<string, Uint8Array>) {}
  readText(relativePath: string): Promise<string> {
    if (relativePath !== 'index.json') return Promise.reject(new Error(`HTTP 404 ${relativePath}`));
    return Promise.resolve(JSON.stringify(this.index));
  }
  download(relativePath: string, options: BundleDownloadOptions): Promise<Uint8Array> {
    this.downloads += 1;
    const bytes = this.bundles[relativePath];
    if (!bytes) return Promise.reject(new Error(`HTTP 404 ${relativePath}`));
    options.onProgress?.(bytes.byteLength);
    return Promise.resolve(bytes);
  }
  urlOf(relativePath: string): string {
    return `https://download.test/market/${relativePath}`;
  }
}

/** Packs an App and publishes it on a fresh site; the market over that site. */
async function publish(id: string, permissions?: { network: string[]; capabilities?: string[] }, at: typeof source = source) {
  const dir = path.join(work, 'src', id);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    id, name: 'Share', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, platforms: ['desktop'], entry: 'index.html',
    ...(permissions ? { permissions } : {}), contributes: { tabs: [{ name: 'main', title: 'Share' }] },
  };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
  const { bytes, sha256 } = await packExtensionArchive(service, dir);
  const row: MarketIndexVersion = {
    version: '1.0.0', manifest, apiVersion: EXTENSION_API_VERSION, minAppVersion: '0.1.0', releaseNotes: 'Shares a file.',
    publishedAt: '2026-10-15T00:00:00Z', sha256, bytes: bytes.byteLength, bundle: `bundles/${id}/1.0.0.zip`, icon: null, readme: null,
    source: at, yanked: null,
  };
  const site = new Site({ apps: [{ id, deprecated: null, versions: [row] }] }, { [row.bundle]: new Uint8Array(bytes) });
  const market = new CloudExtensionMarket(site, {
    stagingRoot: path.join(state.userData, 'extension-market', 'staging'),
    heldRoot: path.join(state.userData, 'extension-market', 'held'),
    resolveHost: async () => ({ platform: 'desktop' as const, appVersion: '0.2.60', apiVersionMin: EXTENSION_API_VERSION, apiVersionMax: EXTENSION_API_VERSION }),
    snapshotStore: { read: async () => null, write: async () => undefined },
  });
  return { site, market, sha256 };
}

/** What is left unpacked under the market's two folders: nothing, once an install is done with. */
function leftovers(): string[] {
  const root = path.join(state.userData, 'extension-market');
  return ['staging', 'held'].flatMap((folder) => (existsSync(path.join(root, folder)) ? readdirSync(path.join(root, folder)).map((name) => `${folder}/${name}`) : []));
}

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'gugu-market-install-'));
  state.userData = path.join(work, 'userData');
  progress.mockClear();
  service = new ExtensionsService(path.join(state.userData, 'task-extensions'));
  state.service = service;
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('installing an App from the market (installExtensionFromMarket)', () => {
  it('asks here when it asks for something — the sheet says where its code is and what this version changed — and installs it as the market’s', async () => {
    const { market } = await publish('share', { network: ['api.example.com'] });
    const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'confirmed' });

    const result = await installExtensionFromMarket({ ref: { extensionId: 'share' } }, { ...quiet, market, requestInstallConsent });

    expect(result).toMatchObject({ installed: true, outcome: 'confirmed', id: 'share', version: '1.0.0', asked: true });
    expect(requestInstallConsent).toHaveBeenCalledWith(expect.objectContaining({ market: { source, releaseNotes: 'Shares a file.' } }));
    expect(service.origins().share).toBe('market');
    // The card's 「下载中」 is drawn from these, as before.
    expect(progress.mock.calls.map(([, data]) => data)).toContainEqual(expect.objectContaining({ extensionId: 'share', version: '1.0.0' }));
    expect(leftovers()).toEqual([]);
  });

  it('`return` hands back what it would ask and keeps the bytes; `given` installs those very bytes — fetched once', async () => {
    const { site, market, sha256 } = await publish('share', { network: ['api.example.com'] });
    const requestInstallConsent = vi.fn();

    const asked = await installExtensionFromMarket({ ref: { extensionId: 'share' }, consent: { kind: 'return' } }, { ...quiet, market, requestInstallConsent });
    expect(asked).toMatchObject({ installed: false, outcome: 'ask', asks: true, ask: { market: { source, releaseNotes: 'Shares a file.' } } });
    expect(asked).not.toHaveProperty('ask.sourceDir');
    expect(service.list().extensions).toEqual([]);
    expect(leftovers()).toEqual([`held/${sha256}`]);

    const digest = asked.outcome === 'ask' ? asked.ask.manifestDigest : '';
    const done = await installExtensionFromMarket({ ref: { extensionId: 'share', version: '1.0.0' }, consent: { kind: 'given', digest } }, { ...quiet, market, requestInstallConsent });
    expect(done).toMatchObject({ installed: true, id: 'share' });
    // Asked once, by the caller — never a second time here; and the package came down once.
    expect(requestInstallConsent).not.toHaveBeenCalled();
    expect(site.downloads).toBe(1);
    expect(leftovers()).toEqual([]);
  });

  it('`return` for an App asking nothing says so (asks: false): the caller installs it at once, as a click is consent', async () => {
    const { market } = await publish('quiet-one');
    const asked = await installExtensionFromMarket({ ref: { extensionId: 'quiet-one' }, consent: { kind: 'return' } }, { ...quiet, market });
    expect(asked).toMatchObject({ installed: false, outcome: 'ask', asks: false });
  });

  it('`given` for other bytes than the ones agreed to installs nothing, and lets the kept copy go', async () => {
    const { market } = await publish('share', { network: ['api.example.com'] });
    await installExtensionFromMarket({ ref: { extensionId: 'share' }, consent: { kind: 'return' } }, { ...quiet, market });
    await expect(installExtensionFromMarket({ ref: { extensionId: 'share', version: '1.0.0' }, consent: { kind: 'given', digest: 'not-it' } }, { ...quiet, market }))
      .rejects.toThrow(/not the one the person agreed to/);
    expect(service.list().extensions).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it('declined: nothing installed, nothing left unpacked', async () => {
    const { market } = await publish('share', { network: ['api.example.com'] });
    const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'declined' });
    await expect(installExtensionFromMarket({ ref: { extensionId: 'share' } }, { ...quiet, market, requestInstallConsent }))
      .resolves.toMatchObject({ installed: false, outcome: 'declined', id: 'share' });
    expect(service.list().extensions).toEqual([]);
    expect(leftovers()).toEqual([]);
  });
});

// 161 10-16 (owner: no prompt for our own Apps): the first-run set goes in asking nobody — gugu's own Apps, as gugu reviewed them, as a
// preinstalled App did. Only one whose code is in gugu's own repository, and never over an App already here.
describe("putting in gugu's own App without asking (consent: gugu, the first-run set)", () => {
  it("asks nobody, and records it as the market's App: what it asks for kept as its manifest says, nothing withdrawn", async () => {
    const { market } = await publish('share', { network: ['api.example.com'], capabilities: ['files:read'] });
    const requestInstallConsent = vi.fn();
    const result = await installExtensionFromMarket({ ref: { extensionId: 'share', version: '1.0.0' }, consent: { kind: 'gugu' } }, { ...quiet, market, requestInstallConsent });
    expect(result).toMatchObject({ installed: true, outcome: 'confirmed', id: 'share', asked: false });
    expect(requestInstallConsent).not.toHaveBeenCalled();
    expect(service.origins().share).toBe('market');
    expect(service.identityOf('share')).toEqual({ publisher: 'gugu', id: 'share' });
    expect(service.get('share').manifest.permissions).toMatchObject({ network: ['api.example.com'], capabilities: ['files:read'] });
    expect(service.revokedPermissions('share')).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it("an App whose code is in someone else's repository is refused — however the index lists it", async () => {
    const { market } = await publish('theirs', undefined, { repo: 'someone/their-apps', path: '.', commit: 'd'.repeat(40) });
    await expect(installExtensionFromMarket({ ref: { extensionId: 'theirs', version: '1.0.0' }, consent: { kind: 'gugu' } }, { ...quiet, market }))
      .rejects.toThrow(/not gugu's own App \(its code is at someone\/their-apps\)/);
    expect(service.list().extensions).toEqual([]);
    expect(leftovers()).toEqual([]);
    // Control: the same App asked about as usual (no consent kind) installs — it is the asking-nobody that is refused.
    await expect(installExtensionFromMarket({ ref: { extensionId: 'theirs', version: '1.0.0' } }, { ...quiet, market })).resolves.toMatchObject({ installed: true });
  });

  it('never over an App installed here (its update asks as any update does); files whose install a start cut off go in again', async () => {
    const { market } = await publish('share');
    await installExtensionFromMarket({ ref: { extensionId: 'share', version: '1.0.0' } }, { ...quiet, market });
    await expect(installExtensionFromMarket({ ref: { extensionId: 'share', version: '1.0.0' }, consent: { kind: 'gugu' } }, { ...quiet, market }))
      .rejects.toThrow(/installed here already/);
    // The start ended after the files landed, before their record: no origin on record — not an App anyone installed.
    const origins = path.join(state.userData, 'task-extensions', '.extension-origins.json');
    writeFileSync(origins, '{}');
    expect(service.origins().share).toBeUndefined();
    await expect(installExtensionFromMarket({ ref: { extensionId: 'share', version: '1.0.0' }, consent: { kind: 'gugu' } }, { ...quiet, market }))
      .resolves.toMatchObject({ installed: true });
    expect(service.origins().share).toBe('market');
  });
});
