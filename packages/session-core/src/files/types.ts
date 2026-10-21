import type { Result } from '@gugu/session-shared';
import type {
  FileChangeSubscription,
  FileChangeUpdate,
  FileChangeWatchOptions,
} from './changes/types';
import type { FileError } from './errors';
import type { IFileSystem } from './fs/types';
import type { FileTreeError } from './tree/errors';
import type { FileTreeLease } from './tree/types';

export interface IFilesRuntime {
  openTree(rootPath: string): Promise<Result<FileTreeLease, FileTreeError>>;
  watchChanges(
    rootPath: string,
    cb: (update: FileChangeUpdate) => void,
    options?: FileChangeWatchOptions
  ): Result<FileChangeSubscription, FileError>;
  /**
   * 「我在看这个目录」(打开着的文件所在的目录)。一个目录一个 watch 的平台上,它的事件由此流进覆盖它的
   * 整棵树订阅;一个根就看得到整棵树的平台上,这只是一个没人收事件的单层订阅。返回的函数撤掉它。
   */
  watchDirectory(dirPath: string): Result<() => void, FileError>;
  /** 「root 下面可能变过」:见 IWatchService.nudge(返回有没有兑现)。 */
  nudge(rootPath?: string): Promise<boolean>;
  fileSystem(): Result<IFileSystem, FileError>;
  dispose(): Promise<void>;
}

export type {
  FileChange,
  FileChangeKind,
  FileChangeSubscription,
  FileChangeUpdate,
  FileChangeWatchOptions,
  FileEntryType,
  IFileChanges,
} from './changes/types';
export type {
  FileEnumeration,
  FileEnumerationOptions,
  FileGlob,
  FileGlobOptions,
  FileStat,
  IFileSystem,
  ReadBytesResult,
  ReadFileOptions,
  ReadTextResult,
  WriteFileResult,
} from './fs/types';
export type { FileSymlinkInfo, FileSymlinkTargetType } from './symlinks';
export type {
  DirectoryPreview,
  DirectoryPreviewSegment,
  FileNode,
  FileNodeType,
  FileTreeScope,
  NodeId,
} from './tree/models/tree';
export type {
  FileTreeLease,
  FileTreeSequences,
  FileTreeSnapshot,
  FileTreeUpdate,
  IFileTree,
  SubscribedSnapshot,
} from './tree/types';
