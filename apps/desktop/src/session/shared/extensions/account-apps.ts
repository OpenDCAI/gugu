import { z } from 'zod';
import type { ExtensionManifest } from './manifest';
import { GUGU_APPS_REPO } from './first-run';

export const ACCOUNT_APPS_KEY = 'account_apps';
export const ACCOUNT_APP_ALLOWLIST: readonly string[] = ['browser-use'];

const grantsSchema = z.object({ capabilities: z.array(z.string()), network: z.array(z.string()) });
export const accountAppSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  digestAgreed: z.string().regex(/^[a-f0-9]{64}$/),
  grants: grantsSchema,
  autoUpdate: z.boolean(),
});
export type AccountApp = z.infer<typeof accountAppSchema>;
const recordSchema = z.object({
  version: z.literal(1),
  apps: z.array(accountAppSchema).refine(apps => new Set(apps.map(app => app.id)).size === apps.length, 'Duplicate account App'),
});

/** Missing is an old account; malformed is an error, never permission to install. */
export function accountAppsOf(config: Record<string, unknown>): AccountApp[] {
  const record = config[ACCOUNT_APPS_KEY];
  return record === undefined ? [] : recordSchema.parse(record).apps;
}

export function withAccountApp(config: Record<string, unknown>, entry: AccountApp): Record<string, unknown> {
  const checked = accountAppSchema.parse(entry);
  if (!ACCOUNT_APP_ALLOWLIST.includes(checked.id)) throw new Error('This App is not enabled for account installation');
  const apps = accountAppsOf(config);
  return { ...config, [ACCOUNT_APPS_KEY]: { version: 1, apps: [...apps.filter(app => app.id !== checked.id), checked] } };
}

const sorted = (values: readonly string[]) => [...new Set(values)].sort();
export function manifestGrants(manifest: Pick<ExtensionManifest, 'permissions'>): AccountApp['grants'] {
  return {
    capabilities: sorted(manifest.permissions?.capabilities ?? []),
    network: sorted(manifest.permissions?.network ?? []),
  };
}

/** Both the market's publisher and the exact consent binding are checked at the install boundary. */
export function accountInstallMatches(entry: AccountApp, candidate: {
  manifest: ExtensionManifest; digest: string; repo: string;
}): boolean {
  const { manifest, digest, repo } = candidate;
  const grants = manifestGrants(manifest);
  return ACCOUNT_APP_ALLOWLIST.includes(entry.id) && repo === GUGU_APPS_REPO
    && manifest.id === entry.id && manifest.version === entry.version && digest === entry.digestAgreed
    && JSON.stringify(grants.capabilities) === JSON.stringify(sorted(entry.grants.capabilities))
    && JSON.stringify(grants.network) === JSON.stringify(sorted(entry.grants.network));
}

export type AccountAppState = {
  id: string;
  state: 'installing' | 'installed' | 'excluded' | 'needs-consent' | 'unavailable' | 'failed';
};
export type AccountAppInstallResult = { state: 'installed' | 'needs-consent' | 'unavailable' };

export interface AccountAppsDependencies {
  /** A snapshot of the authenticated owner; current becomes false at an account boundary. */
  account(): Promise<{ userId: string; current(): boolean } | null>;
  record(userId: string): Promise<AccountApp[]>;
  excluded(userId: string): Promise<readonly string[]>;
  here(): Promise<readonly string[]>;
  install(entry: AccountApp, owner: { userId: string; current(): boolean }): Promise<AccountAppInstallResult>;
  changed(userId: string | null, states: AccountAppState[]): void;
  warn(message: string, detail: Record<string, unknown>): void;
}

/** Each machine restores its own missing Apps. A local uninstall always wins, including during a download. */
export async function reconcileAccountApps(deps: AccountAppsDependencies): Promise<void> {
  const owner = await deps.account();
  if (!owner) { deps.changed(null, []); return; }
  const entries = await deps.record(owner.userId);
  if (!owner.current()) return;
  const states: AccountAppState[] = [];
  for (const entry of entries) {
    if (!ACCOUNT_APP_ALLOWLIST.includes(entry.id)) continue;
    if (!owner.current()) return;
    const excluded = await deps.excluded(owner.userId);
    const here = await deps.here();
    if (!owner.current()) return;
    if (excluded.includes(entry.id)) states.push({ id: entry.id, state: 'excluded' });
    else if (here.includes(entry.id)) states.push({ id: entry.id, state: 'installed' });
    else {
      states.push({ id: entry.id, state: 'installing' });
      deps.changed(owner.userId, [...states]);
      try {
        const result = await deps.install(entry, owner);
        if (!owner.current()) return;
        states[states.length - 1] = { id: entry.id, ...result };
      } catch (error) {
        if (!owner.current()) return;
        const reason = error instanceof Error ? error.message : String(error);
        states[states.length - 1] = { id: entry.id, state: 'failed' };
        deps.warn('An account App could not be restored; it will be retried', { id: entry.id, reason });
      }
    }
    deps.changed(owner.userId, [...states]);
  }
  if (owner.current()) deps.changed(owner.userId, states);
}

/** Coalesce repeated auth/boot notifications, but do run once more when the account changed mid-pass. */
export function accountAppsRunner(deps: AccountAppsDependencies): { run(): Promise<void> } {
  let running: Promise<void> | null = null;
  let again = false;
  return {
    run() {
      if (running) { again = true; return running; }
      running = (async () => {
        do {
          again = false;
          try { await reconcileAccountApps(deps); }
          catch (error) {
            deps.warn('Account Apps reconciliation failed', { error: error instanceof Error ? error.message : String(error) });
            // A changed account still gets its own pass. Otherwise the caller must see the real read/auth failure.
            if (!again) throw error;
          }
        } while (again);
      })().finally(() => { running = null; });
      return running;
    },
  };
}
