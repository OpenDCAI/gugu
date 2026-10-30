import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { EXTRACTOR_VERSION, SCHEMA_VERSION, SEARCH_SCHEMA_DROP_SQL, SEARCH_SCHEMA_SQL } from '@gugu/core/shared/search/schema';
import type { SearchIndexOp, SearchQuery } from '@gugu/core/shared/search/types';
import type { MessageSearchRequest } from '@shared/core/message-search';
import { coverageKey, taskCoverageKey, readTaskCoverage, readCoverage, readDateAnchor, readMessages } from './message-store-read';
import { applyOps } from './message-store-write';

function accountPath(userData: string, accountId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) throw new Error('Search account is not bound');
  return join(userData, 'search', accountId + '.sqlite');
}

export function removeMessageSearchAccountFiles(userData: string, accountId: string): void {
  const path = accountPath(userData, accountId);
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
}

/** Derived message index of one account. This never opens the task database or a network connection. */
export class MessageSearchStore {
  private readonly db: Database.Database;
  readonly path: string;
  /**
   * Streams the backfill has reported on since this store was opened. Stored progress alone does not make a chat
   * complete: rows that arrived or left while nothing was feeding the index (app closed, flag off) are only caught
   * up by the backfill's next pass, so completeness has to be earned again in every store lifetime.
   */
  private readonly current = new Set<string>();

  constructor(userData: string, readonly accountId: string) {
    this.path = accountPath(userData, accountId);
    mkdirSync(join(userData, 'search'), { recursive: true, mode: 0o700 });
    this.db = new Database(this.path);
    chmodSync(this.path, 0o600);
    this.db.pragma('foreign_keys=ON');
    this.db.pragma('journal_mode=WAL');
    this.db.transaction(() => {
      this.db.exec('CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const version = this.db.prepare("SELECT value FROM search_meta WHERE key='version'").get() as { value: string } | undefined;
      const expected = SCHEMA_VERSION + ':' + EXTRACTOR_VERSION;
      if (version && version.value !== expected) this.db.exec(SEARCH_SCHEMA_DROP_SQL);
      this.db.exec(SEARCH_SCHEMA_SQL);
      this.db.prepare("INSERT INTO search_meta VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(expected);
    })();
  }

  global(request: MessageSearchRequest, now = Date.now()) {
    return this.db.transaction(() => readMessages(this.db, this.accountId, request, now, this.current))();
  }

  dateAnchor(query: SearchQuery) {
    return readDateAnchor(this.db, this.accountId, query);
  }

  coverage() {
    return readCoverage(this.db);
  }

  taskCoverage() { return readTaskCoverage(this.db); }

  apply(ops: readonly SearchIndexOp[]): void {
    this.db.transaction(() => applyOps(this.db, this.accountId, ops))();
    for (const op of ops) {
      if (op.kind === 'coverage') this.current.add(coverageKey(op.coverage.chatId, op.coverage.threadRootId));
      if (op.kind === 'taskCoverage') {
        if (op.coverage.exhausted) this.current.add(taskCoverageKey(op.coverage.taskId));
        else this.current.delete(taskCoverageKey(op.coverage.taskId));
      }
      if (op.kind === 'removeTask' || op.kind === 'truncateTask') this.current.delete(taskCoverageKey(op.taskId));
    }
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}

/** The one search index of the signed-in account. Signing out or switching accounts deletes the previous one. */
export class AccountMessageSearch {
  private store: MessageSearchStore | null = null;
  private accountId: string | null = null;
  private lifetime: AbortController | null = null;
  private generation = 0;

  constructor(
    private readonly userData: () => string,
    private readonly currentAccount: () => Promise<string | null>,
    private readonly enabled: () => Promise<boolean>,
    private readonly storeOpened?: (store: MessageSearchStore, signal: AbortSignal) => void,
  ) {}

  accountChanged(accountId: string | null): void {
    if (this.accountId === accountId) return;
    this.close();
    if (this.accountId) removeMessageSearchAccountFiles(this.userData(), this.accountId);
    this.accountId = accountId;
  }

  close(): void {
    this.generation++;
    this.lifetime?.abort();
    this.lifetime = null;
    this.store?.close();
    this.store = null;
  }

  private async open(): Promise<MessageSearchStore> {
    if (!(await this.enabled())) { this.close(); throw new Error('Global search is not enabled'); }
    return this.openEnabled();
  }

  private async openEnabled(): Promise<MessageSearchStore> {
    const generation = this.generation;
    const accountId = await this.currentAccount();
    if (generation !== this.generation) throw new Error('Search account changed while opening');
    if (!accountId) throw new Error('Search is not signed in');
    this.accountChanged(accountId);
    if (!this.store) {
      this.store = new MessageSearchStore(this.userData(), accountId);
      this.lifetime = new AbortController();
      this.storeOpened?.(this.store, this.lifetime.signal);
    }
    return this.store;
  }

  async global(request: MessageSearchRequest) { return (await this.open()).global(request); }
  async dateAnchor(query: SearchQuery) { return (await this.open()).dateAnchor(query); }
  async coverage() { return (await this.open()).coverage(); }
  /**
   * The only write, and the one place that decides whether the index is written. Off: nothing is opened and the ops
   * are dropped (false). A dropped write also closes an open store, so its completeness has to be earned again.
   */
  async update(read: (store: MessageSearchStore) => readonly SearchIndexOp[], expected?: MessageSearchStore): Promise<boolean> {
    if (!(await this.enabled())) { this.close(); return false; }
    if (expected && this.store !== expected) return false;
    const store = await this.openEnabled();
    if (expected && store !== expected) return false;
    store.apply(read(store));
    return true;
  }

  async write(ops: readonly SearchIndexOp[]): Promise<boolean> {
    return this.update(() => ops);
  }
}
