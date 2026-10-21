import { lstatSync } from 'node:fs';
import { sep } from 'node:path';
import { err, ok, type Result } from '@gugu/session-shared';
import type { IWatchService, WatchEvent, WatchHandle } from '../../services/fs-watch/api';
import { classifyFileError, type FileError } from '../errors';
import { includeAllFiles } from '../exclusions';
import { createRootPathPolicy, type RootPathPolicy } from '../path-policy';
import type {
  FileChange,
  FileChangeSubscription,
  FileChangeUpdate,
  FileChangeWatchOptions,
  FileEntryType,
  IFileChanges,
} from './types';

const DEFAULT_CHANGE_DEBOUNCE_MS = 100;

export type FileChangesOptions = {
  rootPath: string;
  watcher: IWatchService;
};

export class FileChanges implements IFileChanges {
  readonly rootPath: string;
  private readonly pathPolicy: RootPathPolicy;
  private readonly watcher: IWatchService;
  private readonly subscriptions = new Set<WatchHandle>();
  private disposed = false;

  constructor(options: FileChangesOptions) {
    const policy = createRootPathPolicy(options.rootPath);
    if (!policy.success) throw new Error(policy.error.message);
    this.pathPolicy = policy.data;
    this.rootPath = this.pathPolicy.rootPath;
    this.watcher = options.watcher;
  }

  watch(
    cb: (update: FileChangeUpdate) => void,
    options: FileChangeWatchOptions = {}
  ): Result<FileChangeSubscription, FileError> {
    if (this.disposed) {
      return err({
        type: 'fs-error',
        path: this.rootPath,
        message: 'FileChanges disposed',
      });
    }

    const watchedPaths = normalizeWatchedPaths(this.pathPolicy, options.paths);
    if (!watchedPaths.success) return watchedPaths;
    const exclude = options.exclude ?? includeAllFiles;

    // 订阅范围 = 调用方声明的范围,不是「订整根、拿到事件再丢掉 99%」。
    // 监听根是用户挑的目录(项目根 / 任务工作区 / 家目录),大小没有上界;而 macOS 上唯一可用的
    // backend 代价随未忽略 entry 数线性增长 —— 订整根等于把代价交给用户的磁盘决定。
    // 契约本来就允许在这一层收窄(见 FileChangeWatchOptions.paths),SSH 那份实现也早就这么做了。
    // 一条 path 一个订阅,所以重复或互相嵌套的声明必须先收成最小覆盖集:否则同一个事件会被
    // 两个 handle 各送一次,消费者那边就是索引更新/编辑器失效各跑两遍。
    const recursive = options.recursive ?? true;
    const declared = watchedPaths.data.map((policy) => policy.rootPath);
    const watchRoots =
      declared.length > 0
        ? recursive
          ? minimalCoveringRoots(declared)
          : [...new Set(declared)]
        : [this.pathPolicy.rootPath];

    const handles = watchRoots.map((watchRoot) =>
      this.watcher.watch(
        watchRoot,
        (events) => {
          const changes = rawEventsToChanges(this.pathPolicy, events, watchedPaths.data, exclude);
          if (changes.length > 0) cb({ kind: 'changes', changes });
        },
        {
          ignore: options.ignore,
          recursive,
          coarse: options.coarse,
          debounceMs: options.debounceMs ?? DEFAULT_CHANGE_DEBOUNCE_MS,
          onResync: () => cb({ kind: 'resync' }),
        }
      )
    );
    for (const handle of handles) this.subscriptions.add(handle);

    let unsubscribed = false;
    const unsubscribe = () => {
      if (unsubscribed) return;
      unsubscribed = true;
      for (const handle of handles) {
        this.subscriptions.delete(handle);
        handle.release();
      }
    };

    return ok({
      ready: async () => {
        try {
          await Promise.all(handles.map((handle) => handle.ready()));
          return ok<void>();
        } catch (error) {
          return err(classifyFileError(error, this.rootPath));
        }
      },
      unsubscribe,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const handle of this.subscriptions) handle.release();
    this.subscriptions.clear();
  }
}

/** 去重,并丢掉被其它根包住的根 —— 事件覆盖面不变,订阅数与投递次数都不重复。 */
function minimalCoveringRoots(roots: string[]): string[] {
  const unique = [...new Set(roots)].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const root of unique) {
    const covered = kept.some(
      (existing) => root === existing || root.startsWith(existing.endsWith(sep) ? existing : existing + sep)
    );
    if (!covered) kept.push(root);
  }
  return kept;
}

function normalizeWatchedPaths(
  pathPolicy: RootPathPolicy,
  paths: string[] | undefined
): Result<RootPathPolicy[], FileError> {
  if (!paths || paths.length === 0) return ok([]);
  const normalized: RootPathPolicy[] = [];
  for (const input of paths) {
    const resolved = pathPolicy.resolveInsideRoot(input);
    if (!resolved.success) return resolved;
    const nestedPolicy = createRootPathPolicy(resolved.data);
    if (!nestedPolicy.success) return nestedPolicy;
    normalized.push(nestedPolicy.data);
  }
  return ok(normalized);
}

function rawEventsToChanges(
  pathPolicy: RootPathPolicy,
  events: WatchEvent[],
  watchedPaths: RootPathPolicy[],
  exclude: (absPath: string) => boolean
): FileChange[] {
  const changes: FileChange[] = [];
  for (const event of events) {
    const absPath = pathPolicy.absoluteFromWatchEvent(event.path);
    if (!absPath) continue;
    if (exclude(absPath)) continue;
    if (!isWatchedPath(absPath, pathPolicy, watchedPaths)) continue;
    changes.push({
      kind: event.kind,
      path: absPath,
      entryType: entryTypeForRawEvent(event),
    });
  }
  return changes;
}

function isWatchedPath(
  absPath: string,
  pathPolicy: RootPathPolicy,
  watchedPaths: RootPathPolicy[]
): boolean {
  if (watchedPaths.length === 0) return pathPolicy.contains(absPath);
  return watchedPaths.some((watchedPath) => watchedPath.contains(absPath));
}

function entryTypeForRawEvent(event: WatchEvent): FileEntryType {
  if (event.kind === 'delete') return 'unknown';
  try {
    const stat = lstatSync(event.path);
    if (stat.isSymbolicLink()) return 'symlink';
    return stat.isDirectory() ? 'directory' : 'file';
  } catch {
    return 'unknown';
  }
}
