import {
  type FileChange,
  type FileChangeUpdate,
  type FileEnumerationOptions,
  type FileError,
} from '@gugu/session-core/files';
import type { Result } from '@gugu/session-shared';
import { log } from '@main/lib/logger';
import { collectWithBudget } from './collect-with-budget';
import { createSearchIndexExclusion } from './search-index-exclusions';
import {
  WorkspaceFileIndexStore,
  type FileHit,
  type IWorkspaceFileIndexStore,
} from './workspace-file-index-store';

const STALE_DAYS = 14;
const DEFAULT_MAX_FILES = 50_000;
const DEFAULT_REINDEX_TIMEOUT_MS = 30_000;
const DEFAULT_REINDEX_DEBOUNCE_MS = 3_000;
const CHANGE_BATCH_SIZE = 250;

export type WorkspaceFileEnumerator = (
  rootPath: string,
  options?: FileEnumerationOptions
) => Result<AsyncIterable<string>, FileError>;

export type WorkspaceFileIndexSource = {
  rootPath: string;
  enumerate: WorkspaceFileEnumerator;
};

export type WorkspaceFileIndexServiceOptions = {
  store?: IWorkspaceFileIndexStore;
  maxFiles?: number;
  reindexTimeoutMs?: number;
  reindexDebounceMs?: number;
  now?: () => number;
};

export class WorkspaceFileIndexService {
  private readonly store: IWorkspaceFileIndexStore;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeSources = new Map<string, WorkspaceFileIndexSource>();
  private workspaceQueues = new Map<string, Promise<void>>();
  private evictionBarrier: Promise<void> = Promise.resolve();

  constructor(private readonly options: WorkspaceFileIndexServiceOptions = {}) {
    this.store = options.store ?? new WorkspaceFileIndexStore();
  }

  initialize(): void {
    const priorWrites = Promise.all(this.workspaceQueues.values());
    const eviction = priorWrites.then(() => this.store.evict(STALE_DAYS));
    this.evictionBarrier = eviction.then(
      () => undefined,
      (error) => {
        log.warn('WorkspaceFileIndexService: eviction failed', { error: String(error) });
      }
    );
    void eviction.catch(() => undefined);
  }

  async onWorkspaceFileChange(workspaceId: string, update: FileChangeUpdate): Promise<void> {
    await this.enqueueWorkspaceWrite(workspaceId, () => this.applyWorkspaceFileChange(workspaceId, update));
  }

  async onWorkspaceActivated(workspaceId: string, source: WorkspaceFileIndexSource): Promise<void> {
    this.activeSources.set(workspaceId, source);
    await this.enqueueWorkspaceWrite(workspaceId, () => this.activateWorkspace(workspaceId, source));
  }

  onWorkspaceDeactivated(workspaceId: string): void {
    // Do not touch meta here: that would reset the staleness clock on every destroy
    // and prevent eviction of stale entries for frequently-cycled workspaces.
    this.activeSources.delete(workspaceId);
    this.clearDebounceTimer(workspaceId);
  }

  deleteIndex(workspaceId: string): void {
    void this.enqueueWorkspaceWrite(workspaceId, () => this.store.deleteIndex(workspaceId));
  }

  /** 现在就重扫一遍,扫完才返回(搜索刚被打开时用:接着搜的那几个字要看到它)。 */
  async reindex(workspaceId: string): Promise<void> {
    if (!this.activeSources.has(workspaceId)) return;
    this.clearDebounceTimer(workspaceId);
    await this.enqueueWorkspaceWrite(workspaceId, () => this.reindexNow(workspaceId));
  }

  searchFiles(workspaceId: string, query: string, limit = 20): FileHit[] {
    return this.store.searchFiles(workspaceId, query, limit);
  }

  search(workspaceId: string, query: string): FileHit[] {
    return this.store.search(workspaceId, query);
  }

  private async applyWorkspaceFileChange(
    workspaceId: string,
    update: FileChangeUpdate
  ): Promise<void> {
    if (update.kind === 'resync') {
      this.scheduleReindex(workspaceId);
      return;
    }
    if (update.changes.length === 0) return;

    const meta = this.store.getMeta(workspaceId);
    if (!meta) {
      this.scheduleReindex(workspaceId);
      return;
    }
    if (meta.status === 'stale') {
      this.scheduleReindex(workspaceId);
      return;
    }
    if (meta.status === 'truncated') return;
    if (update.changes.every((change) => change.kind === 'update')) return;

    await this.applyChanges(workspaceId, update.changes);
  }

  private async activateWorkspace(
    workspaceId: string,
    source: WorkspaceFileIndexSource
  ): Promise<void> {
    const meta = this.store.getMeta(workspaceId);

    if (meta && meta.rootPath !== source.rootPath) {
      await this.store.deleteIndex(workspaceId);
      await this.reindexNow(workspaceId);
      return;
    }

    if (meta?.status === 'complete') {
      this.store.refreshMetaTimestamp(workspaceId);
      return;
    }

    await this.reindexNow(workspaceId);
  }

  private async reindexNow(workspaceId: string): Promise<void> {
    try {
      const source = this.activeSources.get(workspaceId);
      if (!source) return;

      const exclude = createSearchIndexExclusion(source.rootPath);
      const enumeration = source.enumerate(source.rootPath, { exclude });
      if (!enumeration.success) {
        log.warn('WorkspaceFileIndexService: enumerate failed to start', {
          workspaceId,
          error: enumeration.error,
        });
        return;
      }

      const result = await collectWithBudget(filterExcluded(enumeration.data, exclude), {
        maxFiles: this.maxFiles,
        timeoutMs: this.reindexTimeoutMs,
        now: this.options.now,
      });
      if (this.activeSources.get(workspaceId) !== source) return;

      this.store.recordMeta(workspaceId, {
        rootPath: source.rootPath,
        status: 'stale',
        fileCount: this.store.countIndexedFiles(workspaceId),
        truncateReason: null,
      });
      const synced = await this.store.syncRows(workspaceId, result.paths, () => {
        return this.activeSources.get(workspaceId) === source;
      });
      if (!synced || this.activeSources.get(workspaceId) !== source) return;
      this.store.recordMeta(workspaceId, {
        rootPath: source.rootPath,
        status: result.truncated ? 'truncated' : 'complete',
        fileCount: result.paths.length,
        truncateReason: result.truncateReason ?? null,
      });

      const logPayload = {
        workspaceId,
        count: result.paths.length,
        truncated: result.truncated,
        truncateReason: result.truncateReason,
      };
      if (result.truncated) {
        log.warn('WorkspaceFileIndexService: indexed partial workspace', logPayload);
      } else {
        log.info('WorkspaceFileIndexService: indexed workspace', logPayload);
      }
    } catch (e) {
      log.warn('WorkspaceFileIndexService: reindex failed', { workspaceId, error: String(e) });
    }
  }

  private async applyChanges(workspaceId: string, changes: FileChange[]): Promise<void> {
    let needsReindex = false;
    const rootPath = this.metaRootPath(workspaceId);
    const exclude = createSearchIndexExclusion(rootPath);
    try {
      const source = this.activeSources.get(workspaceId);
      if (!source) return;
      let indexedFileCount = this.store.countIndexedFiles(workspaceId);
      for (let offset = 0; offset < changes.length; offset += CHANGE_BATCH_SIZE) {
        if (this.activeSources.get(workspaceId) !== source) return;
        const batch = changes.slice(offset, offset + CHANGE_BATCH_SIZE);
        const subtrees: string[] = [];
        this.store.transaction(() => {
          for (const change of batch) {
            if (exclude(change.path)) continue;

            if (change.kind === 'delete') {
              if (change.entryType === 'file') {
                if (this.store.deletePath(workspaceId, change.path)) {
                  indexedFileCount = Math.max(0, indexedFileCount - 1);
                }
              } else {
                subtrees.push(change.path);
              }
              continue;
            }

            if (change.entryType === 'directory' || change.entryType === 'symlink') {
              needsReindex = true;
              continue;
            }

            if (change.kind === 'create') {
              if (indexedFileCount >= this.maxFiles) {
                needsReindex = true;
                continue;
              }
              if (this.store.insertPath(workspaceId, change.path)) indexedFileCount += 1;
            }
          }
        });
        for (const path of subtrees) {
          await this.store.deleteSubtree(workspaceId, path);
          indexedFileCount = this.store.countIndexedFiles(workspaceId);
        }
        if (offset + CHANGE_BATCH_SIZE < changes.length) await yieldToEventLoop();
      }

      if (needsReindex) {
        this.markStale(workspaceId);
        this.scheduleReindex(workspaceId);
        return;
      }

      this.store.recordMeta(workspaceId, {
        rootPath: this.metaRootPath(workspaceId),
        status: 'complete',
        fileCount: this.store.countIndexedFiles(workspaceId),
        truncateReason: null,
      });
    } catch (e) {
      log.warn('WorkspaceFileIndexService: incremental update failed', {
        workspaceId,
        error: String(e),
      });
      this.markStale(workspaceId);
      this.scheduleReindex(workspaceId);
    }
  }

  private scheduleReindex(workspaceId: string): void {
    if (!this.activeSources.has(workspaceId)) return;
    this.clearDebounceTimer(workspaceId);

    this.debounceTimers.set(
      workspaceId,
      setTimeout(() => {
        this.debounceTimers.delete(workspaceId);
        void this.enqueueWorkspaceWrite(workspaceId, () => this.reindexNow(workspaceId));
      }, this.reindexDebounceMs)
    );
  }

  private clearDebounceTimer(workspaceId: string): void {
    const timer = this.debounceTimers.get(workspaceId);
    if (timer) clearTimeout(timer);
    this.debounceTimers.delete(workspaceId);
  }

  private markStale(workspaceId: string): void {
    try {
      this.store.recordMeta(workspaceId, {
        rootPath: this.metaRootPath(workspaceId),
        status: 'stale',
        fileCount: this.store.countIndexedFiles(workspaceId),
        truncateReason: null,
      });
    } catch (e) {
      log.warn('WorkspaceFileIndexService: markStale failed', { workspaceId, error: String(e) });
    }
  }

  private get maxFiles(): number {
    return this.options.maxFiles ?? DEFAULT_MAX_FILES;
  }

  private get reindexTimeoutMs(): number {
    return this.options.reindexTimeoutMs ?? DEFAULT_REINDEX_TIMEOUT_MS;
  }

  private get reindexDebounceMs(): number {
    return this.options.reindexDebounceMs ?? DEFAULT_REINDEX_DEBOUNCE_MS;
  }

  private metaRootPath(workspaceId: string): string {
    return (
      this.activeSources.get(workspaceId)?.rootPath ??
      this.store.getMeta(workspaceId)?.rootPath ??
      ''
    );
  }

  private enqueueWorkspaceWrite<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.workspaceQueues.get(workspaceId) ?? Promise.resolve();
    const barrier = this.evictionBarrier;
    const queued = prior
      .catch(() => undefined)
      .then(() => barrier)
      .then(operation);
    const settled = queued.then(
      () => undefined,
      () => undefined
    );
    this.workspaceQueues.set(workspaceId, settled);
    settled.then(() => {
      if (this.workspaceQueues.get(workspaceId) === settled) {
        this.workspaceQueues.delete(workspaceId);
      }
    });
    return queued;
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function* filterExcluded(
  paths: AsyncIterable<string>,
  exclude: (absPath: string) => boolean
): AsyncIterable<string> {
  for await (const path of paths) {
    if (!exclude(path)) yield path;
  }
}

export const workspaceFileIndexService = new WorkspaceFileIndexService({
  store: new WorkspaceFileIndexStore(),
});
