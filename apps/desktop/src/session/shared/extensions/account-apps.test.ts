import { describe, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION, parseExtensionManifest } from './manifest';
import { GUGU_APPS_REPO } from './first-run';
import {
  ACCOUNT_APPS_KEY, accountAppsOf, accountAppsRunner, accountInstallMatches, manifestGrants,
  reconcileAccountApps, withAccountApp, type AccountApp, type AccountAppsDependencies, type AccountAppState,
} from './account-apps';

const manifest = () => parseExtensionManifest({
  id: 'browser-use', name: 'Browser Use', version: '1.0.0', apiVersion: EXTENSION_API_VERSION,
  platforms: ['desktop'], entry: 'index.html', contributes: {
    tabs: [{ name: 'main', title: 'Browser' }], mcpServers: [{ name: 'browser', host: 'browser-use' }],
  },
  permissions: { capabilities: ['agents:tools'], network: ['api.example.com'] },
});
const entry = (): AccountApp => ({
  id: 'browser-use', version: '1.0.0', digestAgreed: 'a'.repeat(64), grants: manifestGrants(manifest()), autoUpdate: true,
});

function fixture() {
  let current = true;
  const here: string[] = [];
  const excluded: string[] = [];
  const states: { owner: string | null; apps: AccountAppState[] }[] = [];
  const install = vi.fn(async (_app: AccountApp) => ({ state: 'installed' as const }));
  const deps: AccountAppsDependencies = {
    account: async () => ({ userId: 'owner', current: () => current }),
    record: async () => [entry()], excluded: async () => excluded, here: async () => here,
    install: async (app) => { const result = await install(app); if (result.state === 'installed') here.push(app.id); return result; },
    changed: (owner, apps) => states.push({ owner, apps: structuredClone(apps) }), warn: vi.fn(),
  };
  return { deps, here, excluded, states, install, changeOwner: () => { current = false; } };
}

describe('account App consent records', () => {
  it('distinguishes a missing record from malformed approval data', () => {
    expect(accountAppsOf({})).toEqual([]);
    for (const value of [null, {}, { version: 2, apps: [] }, { version: 1, apps: [{ id: 'browser-use' }] }, { version: 1, apps: [entry(), entry()] }]) {
      expect(() => accountAppsOf({ [ACCOUNT_APPS_KEY]: value })).toThrow();
    }
  });

  it('keeps unrelated settings and replaces only the approved App', () => {
    const initial = { profile: { occupation: 'research' }, later: { keep: true } };
    const first = withAccountApp(initial, entry());
    const second = withAccountApp(first, { ...entry(), autoUpdate: false });
    expect(second).toMatchObject(initial);
    expect(accountAppsOf(second)).toEqual([{ ...entry(), autoUpdate: false }]);
    expect(() => withAccountApp(initial, { ...entry(), id: 'other-app' })).toThrow('not enabled');
  });

  it('requires the exact official App, version, digest and permission set', () => {
    const app = entry();
    const candidate = { manifest: manifest(), digest: app.digestAgreed, repo: GUGU_APPS_REPO };
    expect(accountInstallMatches(app, candidate)).toBe(true);
    expect(accountInstallMatches(app, { ...candidate, repo: 'someone/other-apps' })).toBe(false);
    expect(accountInstallMatches(app, { ...candidate, digest: 'b'.repeat(64) })).toBe(false);
    expect(accountInstallMatches(app, { ...candidate, manifest: { ...manifest(), version: '2.0.0' } })).toBe(false);
    expect(accountInstallMatches(app, { ...candidate, manifest: { ...manifest(), id: 'other-app' } })).toBe(false);
    expect(accountInstallMatches({ ...app, id: 'other-app' }, candidate)).toBe(false);
  });

  it('rejects added capabilities and hosts even if a caller repeats the old digest', () => {
    const app = entry();
    const candidate = { manifest: manifest(), digest: app.digestAgreed, repo: GUGU_APPS_REPO };
    expect(accountInstallMatches(app, { ...candidate, manifest: { ...manifest(), permissions: {
      ...manifest().permissions, capabilities: ['agents:tools', 'files:write'],
    } } })).toBe(false);
    expect(accountInstallMatches(app, { ...candidate, manifest: { ...manifest(), permissions: {
      ...manifest().permissions, network: ['api.example.com', 'more.example.com'],
    } } })).toBe(false);
  });

  it('normalizes permission order without inventing any permissions', () => {
    const app = entry();
    app.grants.capabilities.push('agents:tools');
    expect(accountInstallMatches(app, { manifest: manifest(), digest: app.digestAgreed, repo: GUGU_APPS_REPO })).toBe(true);
  });
});

describe('each machine reconciles its own account Apps', () => {
  it('restores a missing App without consulting a source device', async () => {
    const f = fixture();
    await reconcileAccountApps(f.deps);
    expect(f.install).toHaveBeenCalledExactlyOnceWith(entry());
    expect(f.states.at(-1)).toEqual({ owner: 'owner', apps: [{ id: 'browser-use', state: 'installed' }] });
  });

  it('does not replace an existing complete install', async () => {
    const f = fixture(); f.here.push('browser-use');
    await reconcileAccountApps(f.deps);
    expect(f.install).not.toHaveBeenCalled();
  });

  it('keeps a local uninstall excluded across repeated starts without changing the account record', async () => {
    const f = fixture(); f.excluded.push('browser-use');
    await reconcileAccountApps(f.deps); await reconcileAccountApps(f.deps);
    expect(f.install).not.toHaveBeenCalled();
    expect(await f.deps.record('owner')).toEqual([entry()]);
    expect(f.states.at(-1)?.apps).toEqual([{ id: 'browser-use', state: 'excluded' }]);
  });

  it('does not restore Apps outside the allowlist', async () => {
    const f = fixture(); f.deps.record = async () => [{ ...entry(), id: 'another-app' }];
    await reconcileAccountApps(f.deps);
    expect(f.install).not.toHaveBeenCalled();
  });

  it('retries an interrupted download at the next start', async () => {
    const f = fixture(); f.install.mockRejectedValueOnce(new Error('offline'));
    await reconcileAccountApps(f.deps);
    expect(f.states.at(-1)?.apps[0]).toMatchObject({ state: 'failed', reason: 'offline' });
    await reconcileAccountApps(f.deps);
    expect(f.install).toHaveBeenCalledTimes(2);
    expect(f.states.at(-1)?.apps[0].state).toBe('installed');
  });

  it.each(['needs-consent', 'unavailable'] as const)('does not report %s as an installed App', async state => {
    const f = fixture(); f.deps.install = async () => ({ state, reason: 'Not approved or supported here' });
    await reconcileAccountApps(f.deps);
    expect(f.states.at(-1)?.apps[0]).toMatchObject({ state });
    expect(f.here).toEqual([]);
  });

  it('propagates record authorization failures to a caller asking for a retry', async () => {
    const f = fixture(); f.deps.record = async () => { throw new Error('permission denied'); };
    await expect(accountAppsRunner(f.deps).run()).rejects.toThrow('permission denied');
    expect(f.install).not.toHaveBeenCalled();
    expect(f.states).toEqual([]);
  });

  it('does nothing without an account and clears the owner-specific view', async () => {
    const f = fixture(); f.deps.account = async () => null;
    await reconcileAccountApps(f.deps);
    expect(f.install).not.toHaveBeenCalled();
    expect(f.states).toEqual([{ owner: null, apps: [] }]);
  });

  it('stops when an account changes while its record is read', async () => {
    const f = fixture(); f.deps.record = async () => { f.changeOwner(); return [entry()]; };
    await reconcileAccountApps(f.deps);
    expect(f.install).not.toHaveBeenCalled();
    expect(f.states).toEqual([]);
  });

  it('does not publish completion for an account that changed during an install', async () => {
    const f = fixture(); f.install.mockImplementationOnce(async () => { f.changeOwner(); return { state: 'installed' }; });
    await reconcileAccountApps(f.deps);
    expect(f.states.flatMap(state => state.apps).every(app => app.state !== 'installed')).toBe(true);
  });

  it('coalesces repeated notifications and leaves a completed install alone on the extra pass', async () => {
    const f = fixture();
    const runner = accountAppsRunner(f.deps);
    const first = runner.run(); const second = runner.run(); const third = runner.run();
    expect(second).toBe(first); expect(third).toBe(first);
    await first;
    expect(f.install).toHaveBeenCalledTimes(1);
  });

  it('still reconciles the next account when the previous account read fails during a switch', async () => {
    const f = fixture();
    let release!: () => void;
    const oldRead = new Promise<void>(resolve => { release = resolve; });
    f.deps.record = vi.fn().mockImplementationOnce(async () => {
      await oldRead;
      throw new Error('Previous account signed out');
    }).mockResolvedValue([entry()]);
    const runner = accountAppsRunner(f.deps);
    const first = runner.run();
    await Promise.resolve();
    const second = runner.run();
    release();
    await first;
    expect(second).toBe(first);
    expect(f.deps.record).toHaveBeenCalledTimes(2);
    expect(f.install).toHaveBeenCalledTimes(1);
    expect(f.states.at(-1)?.apps[0].state).toBe('installed');
  });
});
