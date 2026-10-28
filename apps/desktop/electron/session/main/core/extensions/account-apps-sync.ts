import { app } from 'electron';
import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { readUserSettingsConfig, mutateUserSettingsConfig, type SettingsTableClient } from '@gugu/core/cloud/userSettings';
import {
  ACCOUNT_APP_ALLOWLIST, accountAppsOf, accountAppsRunner, accountInstallMatches, manifestGrants, withAccountApp,
  type AccountApp, type AccountAppState,
} from '@shared/extensions/account-apps';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { extensionsInventoryChangedChannel } from '@shared/extensions/marketEvents';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import {
  currentAccountAccessToken, currentAccountEpoch, onAccountAccessTokenChanged,
} from './account-token';
import { nativeProgramAvailable, onNativeProgramsChanged } from './extension-programs';
import { extensionsService } from './extensions-root';
import { AccountAppsLocalRecord } from './account-apps-record';

export interface AccountAppOwner { userId: string; token: string; current(): boolean }
export class AccountAppRestoreError extends Error {
  constructor(readonly state: 'installed' | 'needs-consent' | 'unavailable', message: string) { super(message); }
}

let kept: { userData: string; record: AccountAppsLocalRecord } | null = null;
function local(): AccountAppsLocalRecord {
  const userData = app.getPath('userData');
  if (kept?.userData !== userData) kept = { userData, record: new AccountAppsLocalRecord(userData) };
  return kept.record;
}
function settings(owner: AccountAppOwner): SettingsTableClient {
  return createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${owner.token}` } }) as unknown as SettingsTableClient;
}
export async function captureAccountAppOwner(): Promise<AccountAppOwner | null> {
  const epoch = currentAccountEpoch();
  const token = await currentAccountAccessToken();
  const userId = token ? userIdFromSupabaseAccessToken(token) : null;
  if (!token || !userId || epoch !== currentAccountEpoch()) return null;
  return { userId, token, current: () => epoch === currentAccountEpoch() };
}
function assertCurrent(owner: Pick<AccountAppOwner, 'current'>): void {
  if (!owner.current()) throw new Error('The account changed before the App could be installed');
}

/** Read real authenticated account data here: no caller-supplied digest or capability list can approve a restore. */
export async function verifyAccountAppConsent(candidate: { manifest: ExtensionManifest; digest: string; repo: string }): Promise<{
  entry: AccountApp; beforeInstall(): void;
}> {
  const owner = await captureAccountAppOwner();
  if (!owner) throw new AccountAppRestoreError('needs-consent', 'Sign in before restoring an account App');
  const entries = accountAppsOf(await readUserSettingsConfig(settings(owner), owner.userId, 'user'));
  assertCurrent(owner);
  const entry = entries.find(item => item.id === candidate.manifest.id);
  if (!entry || !accountInstallMatches(entry, candidate)) {
    throw new AccountAppRestoreError('needs-consent', 'This version or its capabilities have not been approved for the account');
  }
  for (const program of candidate.manifest.contributes.mcpServers ?? []) {
    if ('host' in program && !nativeProgramAvailable(program.host)) {
      throw new AccountAppRestoreError('unavailable', `This computer does not provide ${program.host}`);
    }
  }
  const beforeInstall = () => {
    assertCurrent(owner);
    if (local().account(owner.userId).excluded.includes(entry.id)) {
      throw new Error('This App was uninstalled on this computer and will not be restored');
    }
  };
  beforeInstall();
  return { entry, beforeInstall };
}

/** A confirmed install remains successful if account sync is offline; the durable local choice is retried. */
export function rememberAccountAppInstall(owner: AccountAppOwner, installed: {
  manifest: ExtensionManifest; manifestDigest: string;
}, autoUpdate: boolean): void {
  if (!owner.current() || !ACCOUNT_APP_ALLOWLIST.includes(installed.manifest.id)) return;
  local().approved(owner.userId, {
    id: installed.manifest.id, version: installed.manifest.version, digestAgreed: installed.manifestDigest,
    grants: manifestGrants(installed.manifest), autoUpdate,
  });
  reconcileInBackground();
}

/** Reserve the opt-out before deleting files. A failed delete restores the previous choice in the same tick. */
export async function uninstallWithAccountChoice(id: string, remove: () => void): Promise<void> {
  if (!ACCOUNT_APP_ALLOWLIST.includes(id)) { remove(); return; }
  const owner = await captureAccountAppOwner();
  if (!owner) { remove(); return; }
  assertCurrent(owner);
  const record = local();
  const previous = record.account(owner.userId);
  record.exclude(owner.userId, id);
  try { remove(); }
  catch (error) { record.restore(owner.userId, previous); throw error; }
  reconcileInBackground();
}

let view: { userId: string | null; apps: AccountAppState[] } = { userId: null, apps: [] };
export const accountAppsState = () => view;
function changed(userId: string | null, apps: AccountAppState[]): void {
  const next = { userId, apps };
  if (JSON.stringify(view) === JSON.stringify(next)) return;
  view = next;
  events.emit(extensionsInventoryChangedChannel, {});
}

const runner = accountAppsRunner({
  account: captureAccountAppOwner,
  record: async (userId) => {
    const owner = await captureAccountAppOwner();
    if (!owner || owner.userId !== userId) throw new Error('The account changed before App settings could be read');
    for (const entry of local().account(userId).pending) {
      if (!ACCOUNT_APP_ALLOWLIST.includes(entry.id)) continue;
      assertCurrent(owner);
      await mutateUserSettingsConfig(settings(owner), userId, 'user', config => withAccountApp(config, entry));
      assertCurrent(owner);
      local().synced(userId, entry);
    }
    const entries = accountAppsOf(await readUserSettingsConfig(settings(owner), userId, 'user'));
    assertCurrent(owner);
    return entries;
  },
  excluded: async userId => local().account(userId).excluded,
  here: async () => {
    const service = extensionsService();
    const origins = service.origins();
    return service.list().extensions.filter(installed => origins[installed.manifest.id] !== undefined).map(installed => installed.manifest.id);
  },
  install: async (entry, owner) => {
    try {
      const { installExtensionFromMarket } = await import('./extension-market-install');
      const outcome = await installExtensionFromMarket({ ref: { extensionId: entry.id, version: entry.version }, consent: { kind: 'account' } }, {
        beforeInstall: () => {
          assertCurrent(owner);
          if (local().account(owner.userId).excluded.includes(entry.id)) throw new Error('This computer excludes the App');
        },
      });
      if (!outcome.installed) throw new Error(`The account App was not installed (${outcome.outcome})`);
      return { state: 'installed' as const };
    } catch (error) {
      if (error instanceof AccountAppRestoreError) {
        log.warn('Account App restoration needs attention', { id: entry.id, state: error.state, error: error.message });
        return { state: error.state };
      }
      throw error;
    }
  },
  changed,
  warn: (message, detail) => log.warn(message, detail),
});

export async function runAccountApps(): Promise<void> { await runner.run(); }
function reconcileInBackground(): void {
  void runAccountApps().catch((error: unknown) => log.warn('Account Apps will be retried at the next start or sign-in', {
    error: error instanceof Error ? error.message : String(error),
  }));
}
let started = false;
/** Desktop and server own an App profile. A web helper reading that profile must not restore into it. */
export function accountAppsAtBoot(browserFeatures: boolean): void {
  if (!browserFeatures || started) return;
  started = true;
  const offAccount = onAccountAccessTokenChanged(() => { changed(null, []); reconcileInBackground(); });
  const offNative = onNativeProgramsChanged(reconcileInBackground);
  app.once('will-quit', () => { offAccount(); offNative(); started = false; });
  reconcileInBackground();
}
