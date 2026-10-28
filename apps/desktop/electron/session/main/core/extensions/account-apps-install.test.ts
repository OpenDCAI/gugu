import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSettingsClient } from '../../../../../../../tests/support/userSettingsTestDouble';
import { ACCOUNT_APPS_KEY, accountAppsOf, manifestGrants } from '@shared/extensions/account-apps';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest';
import { GUGU_APPS_REPO } from '@shared/extensions/first-run';
import type { MarketIndexVersion } from '@shared/extensions/market';
import { ExtensionsService } from './extensions-service';
import { packExtensionArchive } from './extension-archive';
import { CloudExtensionMarket, type MarketBackend } from './market-catalog';
import { setAccountAccessTokenReader, notifyAccountAccessTokenChanged } from './account-token';
import { AccountAppsLocalRecord } from './account-apps-record';

const state = vi.hoisted(() => ({ userData: '', service: null as unknown, client: null as unknown, token: null as string | null }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));
vi.mock('./extensions-root', () => ({ extensionsService: () => state.service }));
vi.mock('@gugu/core/cloud/supabase', async original => ({
  ...await original<typeof import('@gugu/core/cloud/supabase')>(), createGuguSupabaseClient: () => state.client,
}));
vi.mock('./extension-programs', async original => ({
  ...await original<typeof import('./extension-programs')>(), nativeProgramAvailable: () => true,
}));
vi.mock('./market-ranking', () => ({ recordMarketInstall: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@main/lib/events', async original => ({
  ...await original<typeof import('@main/lib/events')>(), events: { emit: vi.fn() },
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { installExtensionFromMarket } = await import('./extension-market-install');
const { runAccountApps } = await import('./account-apps-sync');
const token = (id: string) => `header.${Buffer.from(JSON.stringify({ sub: id })).toString('base64url')}.signature`;
const quiet = { afterInstall: () => {}, notifyInstalledChanged: async () => {} };
let root: string;
let service: ExtensionsService;
let fake: ReturnType<typeof fakeSettingsClient>;

/** Real packed bytes, a checked market and the real install service; only the network is an in-memory site. */
async function publish(options: { capabilities?: string[]; repo?: string } = {}) {
  const dir = path.join(root, 'source');
  mkdirSync(dir, { recursive: true });
  const manifest = parseExtensionManifest({
    id: 'browser-use', name: 'Browser Use', version: '1.0.0', apiVersion: EXTENSION_API_VERSION,
    platforms: ['desktop'], entry: 'index.html', permissions: { capabilities: options.capabilities ?? ['agents:tools'] },
    contributes: { tabs: [{ name: 'main', title: 'Browser' }], mcpServers: [{ name: 'browser', host: 'browser-use' }] },
  });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Browser</title>');
  const { bytes, sha256 } = await packExtensionArchive(service, dir);
  const row: MarketIndexVersion = {
    manifest, version: manifest.version, apiVersion: EXTENSION_API_VERSION, minAppVersion: '0.1.0',
    releaseNotes: '', publishedAt: '2026-10-28T00:00:00Z', sha256, bytes: bytes.byteLength,
    bundle: 'bundles/browser-use/1.0.0.zip', icon: null, readme: null,
    source: { repo: options.repo ?? GUGU_APPS_REPO, path: 'sources/browser-use', commit: 'c'.repeat(40) }, yanked: null,
  };
  const backend: MarketBackend = {
    readText: async () => JSON.stringify({ apps: [{ id: manifest.id, deprecated: null, versions: [row] }] }),
    download: async () => new Uint8Array(bytes), urlOf: relative => `https://download.test/${relative}`,
  };
  const market = new CloudExtensionMarket(backend, {
    stagingRoot: path.join(state.userData, 'extension-market', 'staging'),
    heldRoot: path.join(state.userData, 'extension-market', 'held'),
    resolveHost: async () => ({ platform: 'desktop', appVersion: '0.2.60', apiVersionMin: EXTENSION_API_VERSION, apiVersionMax: EXTENSION_API_VERSION }),
    snapshotStore: { read: async () => null, write: async () => undefined },
  });
  const digest = service.inspectDirectory(dir).manifestDigest;
  const entry = { id: manifest.id, version: manifest.version, digestAgreed: digest, grants: manifestGrants(manifest), autoUpdate: false };
  return { market, dir, manifest, digest, entry };
}
const choice = () => new AccountAppsLocalRecord(state.userData).account('owner');
function approve(entry: Awaited<ReturnType<typeof publish>>['entry']) {
  fake.rows['owner::user'] = { unrelated: true, [ACCOUNT_APPS_KEY]: { version: 1, apps: [entry] } };
}
function leftovers() {
  return ['staging', 'held'].flatMap(folder => {
    const dir = path.join(state.userData, 'extension-market', folder);
    return existsSync(dir) ? readdirSync(dir) : [];
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'gugu-account-install-'));
  state.userData = path.join(root, 'profile');
  service = new ExtensionsService(path.join(state.userData, 'task-extensions'));
  state.service = service;
  fake = fakeSettingsClient({ 'owner::user': { unrelated: true } }); state.client = fake.client;
  state.token = token('owner'); setAccountAccessTokenReader(async () => state.token);
});
afterEach(async () => {
  state.token = null; notifyAccountAccessTokenChanged();
  await runAccountApps().catch(() => undefined);
  setAccountAccessTokenReader(async () => null);
  rmSync(root, { recursive: true, force: true });
});

describe('account installation through the real market boundary', () => {
  it('records a confirmed install, but neither an inspection nor a declined sheet', async () => {
    const p = await publish();
    const ref = { extensionId: 'browser-use', version: '1.0.0' };
    const declined = await installExtensionFromMarket({ ref }, {
      ...quiet, market: p.market, requestInstallConsent: async () => ({ outcome: 'declined' }),
    });
    expect(declined.installed).toBe(false);
    expect(choice().pending).toEqual([]); expect(accountAppsOf(fake.rows['owner::user'])).toEqual([]);
    const asked = await installExtensionFromMarket({ ref, consent: { kind: 'return' } }, { ...quiet, market: p.market });
    expect(asked.outcome).toBe('ask'); expect(choice().pending).toEqual([]);
    await installExtensionFromMarket({ ref, consent: { kind: 'given', digest: p.digest } }, { ...quiet, market: p.market });
    await runAccountApps();
    expect(accountAppsOf(fake.rows['owner::user'])).toEqual([{ ...p.entry, autoUpdate: true }]);
    expect(fake.rows['owner::user'].unrelated).toBe(true); expect(leftovers()).toEqual([]);
  });

  it.each(['first-run', 'automatic-update'] as const)('does not manufacture account consent from a %s install', async origin => {
    const p = await publish();
    await installExtensionFromMarket({ ref: { extensionId: 'browser-use' }, consent: origin === 'first-run'
      ? { kind: 'gugu' } : { kind: 'given', digest: p.digest } }, {
      ...quiet, market: p.market, ...(origin === 'automatic-update' ? { rememberAccountChoice: false } : {}),
    });
    await runAccountApps();
    expect(service.get('browser-use').manifest.version).toBe('1.0.0');
    expect(choice().pending).toEqual([]); expect(accountAppsOf(fake.rows['owner::user'])).toEqual([]);
  });

  it('restores the exact account-approved package without asking and preserves its update choice', async () => {
    const p = await publish(); approve(p.entry);
    const ask = vi.fn();
    await expect(installExtensionFromMarket({ ref: { extensionId: 'browser-use' }, consent: { kind: 'account' } }, {
      ...quiet, market: p.market, requestInstallConsent: ask,
    })).resolves.toMatchObject({ installed: true });
    expect(ask).not.toHaveBeenCalled(); expect(service.autoUpdateOffIds()).toContain('browser-use');
    expect(service.origins()['browser-use']).toBe('market'); expect(leftovers()).toEqual([]);
  });

  it('does not overwrite an installed App even when account consent is directly requested', async () => {
    const p = await publish(); approve(p.entry);
    service.installFromDirectory(p.dir, p.digest, 'market'); service.setEnabled('browser-use', false);
    await expect(installExtensionFromMarket({ ref: { extensionId: 'browser-use' }, consent: { kind: 'account' } }, { ...quiet, market: p.market }))
      .rejects.toMatchObject({ state: 'installed' });
    expect(service.isEnabled('browser-use')).toBe(false); expect(leftovers()).toEqual([]);
  });

  it('repairs files left by a start interrupted before the origin was recorded', async () => {
    const p = await publish(); approve(p.entry);
    service.installFromDirectory(p.dir, p.digest, 'market');
    writeFileSync(path.join(state.userData, 'task-extensions', '.extension-origins.json'), '{}');
    await expect(installExtensionFromMarket({ ref: { extensionId: 'browser-use' }, consent: { kind: 'account' } }, { ...quiet, market: p.market }))
      .resolves.toMatchObject({ installed: true });
    expect(service.origins()['browser-use']).toBe('market');
  });

  it.each(['switch-account', 'local-uninstall'] as const)('refuses to commit after %s while installation is pending', async boundary => {
    const p = await publish(); approve(p.entry);
    await expect(installExtensionFromMarket({ ref: { extensionId: 'browser-use' }, consent: { kind: 'account' } }, {
      ...quiet, market: p.market, beforeInstall: () => {
        if (boundary === 'switch-account') { state.token = token('other'); notifyAccountAccessTokenChanged(); }
        else new AccountAppsLocalRecord(state.userData).exclude('owner', 'browser-use');
      },
    })).rejects.toThrow(boundary === 'switch-account' ? 'account changed' : 'will not be restored');
    expect(service.list().extensions).toEqual([]); expect(leftovers()).toEqual([]);
    // Keep the old owner excluded for teardown; teardown must never ask a real download site.
    new AccountAppsLocalRecord(state.userData).exclude('owner', 'browser-use');
  });

  it('requires review for newly requested capabilities, without changing the approved account record', async () => {
    const p = await publish({ capabilities: ['agents:tools', 'files:write'] });
    approve({ ...p.entry, grants: { ...p.entry.grants, capabilities: ['agents:tools'] } });
    await expect(installExtensionFromMarket({ ref: { extensionId: 'browser-use' }, consent: { kind: 'account' } }, { ...quiet, market: p.market }))
      .rejects.toMatchObject({ state: 'needs-consent' });
    expect(service.list().extensions).toEqual([]); expect(leftovers()).toEqual([]);
    expect(accountAppsOf(fake.rows['owner::user'])[0]?.grants.capabilities).toEqual(['agents:tools']);
    new AccountAppsLocalRecord(state.userData).exclude('owner', 'browser-use');
  });

  it('clears only this account local exclusion after a person explicitly reinstalls', async () => {
    const p = await publish(); const record = new AccountAppsLocalRecord(state.userData);
    record.exclude('owner', 'browser-use'); record.exclude('other', 'browser-use');
    await installExtensionFromMarket({ ref: { extensionId: 'browser-use' }, consent: { kind: 'given', digest: p.digest } }, { ...quiet, market: p.market });
    await runAccountApps();
    expect(choice().excluded).toEqual([]); expect(record.account('other').excluded).toEqual(['browser-use']);
    expect(accountAppsOf(fake.rows['owner::user'])).toHaveLength(1);
  });
});
