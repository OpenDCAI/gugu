import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { ACCOUNT_APP_ALLOWLIST, accountAppSchema, type AccountApp } from '@shared/extensions/account-apps';

const localSchema = z.object({
  version: z.literal(1),
  accounts: z.record(z.string(), z.object({ excluded: z.array(z.string()), pending: z.array(accountAppSchema) })),
});
type LocalRecord = z.infer<typeof localSchema>;
type AccountRecord = LocalRecord['accounts'][string];
const emptyAccount = (): AccountRecord => ({ excluded: [], pending: [] });

/** This computer's decisions, separated by authenticated account. No tokens or machine-wide uninstalls. */
export class AccountAppsLocalRecord {
  private readonly file: string;
  constructor(userData: string) { this.file = path.join(userData, 'account-apps.json'); }

  private read(): LocalRecord {
    try { return localSchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, accounts: {} };
      throw error;
    }
  }

  private update(userId: string, change: (record: AccountRecord) => AccountRecord): void {
    if (!userId) throw new Error('An authenticated account is required');
    const record = this.read();
    const current = Object.hasOwn(record.accounts, userId) ? record.accounts[userId] : emptyAccount();
    const next = localSchema.parse({ ...record, accounts: { ...record.accounts, [userId]: change(current) } });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  account(userId: string): AccountRecord {
    const record = this.read();
    return Object.hasOwn(record.accounts, userId) ? record.accounts[userId] : emptyAccount();
  }

  /** Success on this computer is recorded before the cloud write, so an offline write can be retried. */
  approved(userId: string, app: AccountApp): void {
    const checked = accountAppSchema.parse(app);
    if (!ACCOUNT_APP_ALLOWLIST.includes(app.id)) throw new Error('This App is not enabled for account installation');
    this.update(userId, current => ({
      excluded: current.excluded.filter(id => id !== checked.id),
      pending: [...current.pending.filter(item => item.id !== checked.id), checked],
    }));
  }

  synced(userId: string, app: AccountApp): void {
    this.update(userId, current => ({ ...current, pending: current.pending.filter(item =>
      item.id !== app.id || item.digestAgreed !== app.digestAgreed || item.version !== app.version
      || item.autoUpdate !== app.autoUpdate) }));
  }

  /** Keep account choices, including a cloud write queued while offline. The local exclusion alone prevents restoration. */
  exclude(userId: string, id: string): void {
    if (!ACCOUNT_APP_ALLOWLIST.includes(id)) return;
    this.update(userId, current => ({
      ...current, excluded: [...new Set([...current.excluded, id])],
    }));
  }

  /** Used only to roll back a failed synchronous uninstall, before control yields. */
  restore(userId: string, previous: AccountRecord): void {
    this.update(userId, () => previous);
  }
}
