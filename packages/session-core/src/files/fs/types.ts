import type { Result } from '@gugu/session-shared';
import type { FileError } from '../errors';
import type { FileExclusionPredicate } from '../exclusions';

export type FileStat = {
  path: string;
  type: 'file' | 'directory';
  size: number;
  mtime: Date;
  ctime: Date;
  mode: number;
};

export type ReadFileOptions = {
  maxBytes?: number;
};

export type ReadTextResult = {
  content: string;
  /** True when the sampled bytes are not safe to present as UTF-8 text. */
  binary?: boolean;
  truncated: boolean;
  totalSize: number;
};

export type ReadBytesResult = {
  bytes: Uint8Array;
  truncated: boolean;
  totalSize: number;
};

export type WriteFileResult = {
  bytesWritten: number;
};

export type FileGlobOptions = {
  cwd: string;
  dot?: boolean;
};

export type FileGlob = AsyncIterable<string>;

export type FileEnumeration = AsyncIterable<string>;

export type FileEnumerationOptions = {
  exclude?: FileExclusionPredicate;
  includeSymlinkFiles?: boolean;
};

export interface IFileSystem {
  readText(path: string, options?: ReadFileOptions): Promise<Result<ReadTextResult, FileError>>;
  readBytes(path: string, options?: ReadFileOptions): Promise<Result<ReadBytesResult, FileError>>;
  writeText(path: string, content: string): Promise<Result<WriteFileResult, FileError>>;
  writeBytes(path: string, bytes: Uint8Array): Promise<Result<WriteFileResult, FileError>>;
  stat(path: string): Promise<Result<FileStat, FileError>>;
  /**
   * One shallow listing of `path`, with `.`/`..` omitted and symlinks resolved
   * to the type of their target (same view as calling `stat` on each child).
   * A child that cannot be stat'd (vanished, dangling symlink, unreadable) is
   * dropped; only failing to read the directory itself fails the call.
   *
   * Cost contract: the number of **network** round trips must not grow with
   * the number of children. A remote implementation therefore takes the whole
   * listing from one directory read, since a per-child round trip costs ~1s on
   * a real link and turns a few-hundred-entry directory into minutes. Local
   * implementations may stat per child — those are local syscalls, not round
   * trips. Concurrency is fine; serial per-child round trips are not.
   */
  readDirectory(path: string): Promise<Result<FileStat[], FileError>>;
  exists(path: string): Promise<Result<boolean, FileError>>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>>;
  remove(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>>;
  /** 同一个目录里改名 / 挪动(文件树的「重命名」)。目标已存在 = 失败(`EEXIST`),❌ 悄悄覆盖。 */
  rename(from: string, to: string): Promise<Result<void, FileError>>;
  realPath(path: string): Promise<Result<string, FileError>>;
  copyFile(src: string, dest: string): Promise<Result<void, FileError>>;
  glob(patterns: string[], options: FileGlobOptions): Result<FileGlob, FileError>;
  enumerate(path: string, options?: FileEnumerationOptions): Result<FileEnumeration, FileError>;
}
