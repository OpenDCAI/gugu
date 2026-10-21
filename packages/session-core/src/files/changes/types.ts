import type { Result, Unsubscribe } from '@gugu/session-shared';
import type { FileError } from '../errors';
import type { FileExclusionPredicate } from '../exclusions';

export type FileEntryType = 'file' | 'directory' | 'symlink' | 'unknown';
export type FileChangeKind = 'create' | 'update' | 'delete';

export type FileChange = {
  kind: FileChangeKind;
  path: string;
  entryType: FileEntryType;
};

export type FileChangeUpdate = { kind: 'changes'; changes: FileChange[] } | { kind: 'resync' };

export type FileChangeWatchOptions = {
  /**
   * Absolute paths to include under the watched root. Omitted paths include the whole root.
   * Implementations may apply this at the underlying watch layer or as a
   * consumer-side filter; emitted paths are absolute machine paths.
   */
  paths?: string[];
  /**
   * 订阅层的剪枝 glob：调用方声明「这些子树不属于本工作区的内容」,监听就不进去。
   *
   * 与 `exclude` 的分工：`exclude` 是拿到事件之后的语义过滤,`ignore` 是压根不去监听。
   * 只有后者能省掉代价 —— macOS 上可用的 backend 按未忽略 entry 数逐个开 fd,而监听根是
   * 用户挑的目录,大小没有上界。两者应当出自同一份声明,否则会漂。
   */
  ignore?: string[];
  debounceMs?: number;
  exclude?: FileExclusionPredicate;
  /**
   * false = `paths` 里每个目录只看它自己那一层(与本机文件树同一个粒度,见 WatchOptions.recursive)。
   * 这时互相嵌套的目录各是各的订阅,❌ 被外层「覆盖」掉。缺省 = 递归。
   */
  recursive?: boolean;
  /** 整棵树、粗粒度也行(见 WatchOptions.coarse)。 */
  coarse?: boolean;
};

export type FileChangeSubscription = {
  ready(): Promise<Result<void, FileError>>;
  unsubscribe: Unsubscribe;
};

export interface IFileChanges {
  readonly rootPath: string;
  watch(
    cb: (update: FileChangeUpdate) => void,
    options?: FileChangeWatchOptions
  ): Result<FileChangeSubscription, FileError>;
  dispose(): void;
}
