import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSettingsClient } from '../../../../../../../tests/support/userSettingsTestDouble';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest';
import { ACCOUNT_APPS_KEY, accountAppsOf, manifestGrants, type AccountApp } from '@shared/extensions/account-apps';
import { GUGU_APPS_REPO } from '@shared/extensions/first-run';
import { setAccountAccessTokenReader, notifyAccountAccessTokenChanged } from './account-token';
import { AccountAppsLocalRecord } from './account-apps-record';

const state = vi.hoisted(() => ({
  root: '', token: null as string | null, client: null as unknown, native: true,
  installed: [] as { manifest: { id: string } }[], quit: null as (() => void) | null,
}));
vi.mock('electron', () => ({ app: {
  getPath: () => state.root, once: (_event: string, callback: () => void) => { state.quit = callback; },
} }));
vi.mock('@gugu/core/cloud/supabase', async importOriginal => ({
  ...await importOriginal<typeof import('@gugu/core/cloud/supabase')>(),
  createGuguSupabaseClient: () => state.client,
}));
vi.mock('./extension-programs', () => ({ nativeProgramAvailable: () => state.native, onNativeProgramsChanged: () => () => {} }));
vi.mock('./extensions-root', () => ({ extensionsService: () => ({
  origins: () => Object.fromEntries(state.installed.map(item => [item.manifest.id, 'market'])),
  list: () => ({ extensions: state.installed, invalid: [] }),
}) }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
const sync = await import('./account-apps-sync');

const token = (userId: string) => `header.${Buffer.from(JSON.stringify({ sub: userId })).toString('base64url')}.signature`;
const manifest = () => parseExtensionManifest({
  id: 'browser-use', name: 'Browser Use', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, platforms: ['desktop'],
  entry: 'index.html', permissions: { capabilities: ['agents:tools'] },
  contributes: { tabs: [{ name: 'main', title: 'Browser' }], mcpServers: [{ name: 'browser', host: 'browser-use' }] },
});
const entry = (): AccountApp => ({ id: 'browser-use', version: '1.0.0', digestAgreed: 'a'.repeat(64), grants: manifestGrants(manifest()), autoUpdate: true });
const candidate = () => ({ manifest: manifest(), digest: 'a'.repeat(64), repo: GUGU_APPS_REPO });
let fake: ReturnType<typeof fakeSettingsClient>;

beforeEach(() => {
  state.root = mkdtempSync(path.join(tmpdir(), 'gugu-account-app-sync-'));
  fake = fakeSettingsClient({ 'owner::user': { keep: true, [ACCOUNT_APPS_KEY]: { version: 1, apps: [entry()] } } });
  state.client = fake.client; state.token = token('owner'); state.native = true;
  state.installed = [{ manifest: manifest() }]; state.quit = null;
  setAccountAccessTokenReader(async () => state.token);
});
afterEach(async () => {
  await sync.runAccountApps().catch(() => undefined);
  state.quit?.();
  rmSync(state.root, { recursive: true, force: true });
});

describe('account approval at the real host install boundary', () => {
  it('reconciles at boot and sign-in, and immediately clears the previous account view on sign-out', async () => {
    sync.accountAppsAtBoot(false);
    expect(state.quit).toBeNull();
    sync.accountAppsAtBoot(true);
    await sync.runAccountApps();
    expect(sync.accountAppsState()).toEqual({ userId: 'owner', apps: [{ id: 'browser-use', state: 'installed' }] });
    state.token = null; notifyAccountAccessTokenChanged();
    expect(sync.accountAppsState()).toEqual({ userId: null, apps: [] });
    await sync.runAccountApps();
    state.token = token('owner'); notifyAccountAccessTokenChanged();
    await sync.runAccountApps();
    expect(sync.accountAppsState().userId).toBe('owner');
  });

  it('reads the authenticated record and returns a final commit guard', async () => {
    const approval = await sync.verifyAccountAppConsent(candidate());
    expect(approval.entry).toEqual(entry());
    expect(() => approval.beforeInstall()).not.toThrow();
    notifyAccountAccessTokenChanged();
    expect(() => approval.beforeInstall()).toThrow('account changed');
  });

  it('cannot borrow another account approval', async () => {
    state.token = token('other'); notifyAccountAccessTokenChanged();
    await expect(sync.verifyAccountAppConsent(candidate())).rejects.toMatchObject({ state: 'needs-consent' });
  });

  it('does not turn a missing sign-in into approval', async () => {
    state.token = null; notifyAccountAccessTokenChanged();
    await expect(sync.verifyAccountAppConsent(candidate())).rejects.toMatchObject({ state: 'needs-consent' });
  });

  it.each([
    ['digest', { digest: 'b'.repeat(64) }],
    ['publisher', { repo: 'someone/apps' }],
    ['version', { manifest: { ...manifest(), version: '2.0.0' } }],
    ['capabilities', { manifest: parseExtensionManifest({ ...manifest(), permissions: { capabilities: ['agents:tools', 'files:write'] } }) }],
  ])('requires review for a changed %s', async (_what, change) => {
    await expect(sync.verifyAccountAppConsent({ ...candidate(), ...change } as ReturnType<typeof candidate>))
      .rejects.toMatchObject({ state: 'needs-consent' });
  });

  it('does not install a native App on a host lacking its provider', async () => {
    state.native = false;
    await expect(sync.verifyAccountAppConsent(candidate())).rejects.toMatchObject({ state: 'unavailable' });
  });

  it('checks a local uninstall again immediately before committing the downloaded bundle', async () => {
    const approval = await sync.verifyAccountAppConsent(candidate());
    new AccountAppsLocalRecord(state.root).exclude('owner', 'browser-use');
    expect(() => approval.beforeInstall()).toThrow('will not be restored');
    await expect(sync.verifyAccountAppConsent(candidate())).rejects.toThrow('will not be restored');
  });

  it('keeps permission failures observable rather than returning successful empty settings', async () => {
    state.client = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: null, error: { message: 'permission denied' } }),
    }) }) }) }) };
    await expect(sync.verifyAccountAppConsent(candidate())).rejects.toThrow('permission denied');
    await expect(sync.runAccountApps()).rejects.toThrow('permission denied');
  });

  it('records only the captured account successful install and preserves other settings', async () => {
    const owner = await sync.captureAccountAppOwner();
    sync.rememberAccountAppInstall(owner!, { manifest: manifest(), manifestDigest: 'a'.repeat(64) }, false);
    await sync.runAccountApps();
    expect(accountAppsOf(fake.rows['owner::user'])).toEqual([{ ...entry(), autoUpdate: false }]);
    expect(fake.rows['owner::user'].keep).toBe(true);
    expect(new AccountAppsLocalRecord(state.root).account('owner').pending).toEqual([]);
  });

  it('does not associate an install with the next account after a switch', async () => {
    const owner = await sync.captureAccountAppOwner();
    state.token = token('other'); notifyAccountAccessTokenChanged();
    sync.rememberAccountAppInstall(owner!, { manifest: manifest(), manifestDigest: 'a'.repeat(64) }, true);
    expect(new AccountAppsLocalRecord(state.root).account('other').pending).toEqual([]);
    expect(fake.rows['other::user']).toBeUndefined();
  });

  it('uninstalls only here and keeps the account approval', async () => {
    await sync.uninstallWithAccountChoice('browser-use', () => { state.installed = []; });
    await sync.runAccountApps();
    expect(new AccountAppsLocalRecord(state.root).account('owner').excluded).toEqual(['browser-use']);
    expect(accountAppsOf(fake.rows['owner::user'])).toEqual([entry()]);
    expect(fake.upserts).toHaveLength(0);
  });

  it('rolls back its exclusion when the actual uninstall fails', async () => {
    await expect(sync.uninstallWithAccountChoice('browser-use', () => { throw new Error('unreadable grant file'); }))
      .rejects.toThrow('unreadable grant file');
    expect(new AccountAppsLocalRecord(state.root).account('owner').excluded).toEqual([]);
  });
});
