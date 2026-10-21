import { promises as fs } from 'node:fs';
import path from 'node:path';
import { err, ok, type Result } from '@gugu/session-shared';
import { globIterate } from 'glob';
import { realpathOrResolve } from '../../services/fs-watch/impl/paths';
import { enumerate as enumerateFiles } from '../enumerate';
import { classifyFileError, isFileNotFoundCode, type FileError } from '../errors';
import { validateAbsolutePath } from '../paths';
import type {
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
} from './types';

const DEFAULT_MAX_BYTES = 200 * 1024;
const MAX_READ_BYTES = 100 * 1024 * 1024;

export type Utf8Sample = { content: string; binary?: true };

function hasIncompleteUtf8Suffix(bytes: Uint8Array, trim: number): boolean {
  if (trim === 0 || trim > bytes.length) return false;
  const suffix = bytes.subarray(bytes.length - trim);
  const lead = suffix[0];
  if (lead === undefined) return false;
  const expected =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 0;
  if (expected === 0 || trim >= expected) return false;
  for (let index = 1; index < suffix.length; index += 1) {
    if ((suffix[index] & 0xc0) !== 0x80) return false;
  }
  return true;
}

/** Decode a sampled file prefix without turning invalid bytes into replacement glyphs. */
export function decodeUtf8Sample(bytes: Uint8Array, truncated: boolean): Utf8Sample {
  if (bytes.includes(0)) return { content: '', binary: true };

  try {
    return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    if (truncated) {
      for (let trim = 1; trim <= 3 && trim <= bytes.length; trim += 1) {
        if (!hasIncompleteUtf8Suffix(bytes, trim)) continue;
        try {
          return {
            content: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -trim)),
          };
        } catch {
          // Keep looking for the boundary of the incomplete code point.
        }
      }
    }
    return { content: '', binary: true };
  }
}

export class FileSystem implements IFileSystem {
  async readText(
    absPath: string,
    options?: ReadFileOptions
  ): Promise<Result<ReadTextResult, FileError>> {
    const result = await this.readBytes(absPath, options);
    if (!result.success) return result;
    const decoded = decodeUtf8Sample(result.data.bytes, result.data.truncated);
    return ok({
      content: decoded.content,
      ...(decoded.binary ? { binary: true } : {}),
      truncated: result.data.truncated,
      totalSize: result.data.totalSize,
    });
  }

  async readBytes(
    absPath: string,
    options: ReadFileOptions = {}
  ): Promise<Result<ReadBytesResult, FileError>> {
    const validated = validateAbsolutePath(absPath);
    if (!validated.success) return validated;

    try {
      const stat = await fs.stat(validated.data);
      if (stat.isDirectory()) {
        return err({
          type: 'fs-error',
          path: validated.data,
          message: `Path is a directory: ${validated.data}`,
          code: 'EISDIR',
        });
      }

      const maxBytes = normalizeMaxBytes(options.maxBytes);
      // 超限就**不读**,只回大小(#5750)。此前是读满 maxBytes 再标 `truncated`,可仓里
      // 每一个看这个标志的调用点都把那半截内容直接丢了(设置迁移、git numstat、图片内联),
      // 所以那份 I/O 与它跨进程的搬运从来没人要 —— 上限越大,白搬的越多。
      // 半截内容拿不到手,也就顺带堵死了「拿它当完整内容用」那一类看不出来的错。
      if (stat.size > maxBytes) {
        return ok({ bytes: new Uint8Array(), truncated: true, totalSize: stat.size });
      }

      const readSize = stat.size;
      if (readSize === 0) {
        return ok({ bytes: new Uint8Array(), truncated: false, totalSize: stat.size });
      }

      const handle = await fs.open(validated.data, 'r');
      try {
        const buffer = Buffer.alloc(readSize);
        const { bytesRead } = await handle.read(buffer, 0, readSize, 0);
        // 到这里文件整份都在限内,读的就是全部。
        return ok({ bytes: buffer.subarray(0, bytesRead), truncated: false, totalSize: stat.size });
      } finally {
        await handle.close();
      }
    } catch (error) {
      return err(classifyFileError(error, validated.data));
    }
  }

  async writeText(absPath: string, content: string): Promise<Result<WriteFileResult, FileError>> {
    return this.writeBuffer(absPath, Buffer.from(content, 'utf8'));
  }

  async writeBytes(
    absPath: string,
    bytes: Uint8Array
  ): Promise<Result<WriteFileResult, FileError>> {
    return this.writeBuffer(absPath, Buffer.from(bytes));
  }

  async stat(absPath: string): Promise<Result<FileStat, FileError>> {
    const validated = validateAbsolutePath(absPath);
    if (!validated.success) return validated;

    try {
      const stat = await fs.stat(validated.data);
      return ok({
        path: validated.data,
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.size,
        mtime: stat.mtime,
        ctime: stat.ctime,
        mode: stat.mode,
      });
    } catch (error) {
      return err(classifyFileError(error, validated.data));
    }
  }

  async readDirectory(absPath: string): Promise<Result<FileStat[], FileError>> {
    const validated = validateAbsolutePath(absPath);
    if (!validated.success) return validated;

    let names: string[];
    try {
      names = await fs.readdir(validated.data);
    } catch (error) {
      return err(classifyFileError(error, validated.data));
    }

    const entries: FileStat[] = [];
    for (const name of names) {
      const childPath = path.join(validated.data, name);
      const stat = await this.stat(childPath);
      // A child can vanish between readdir and stat, a symlink can dangle, and
      // a child can be unreadable. None of those is a reason to fail the whole
      // listing — one bad entry must not make the directory unbrowsable.
      if (!stat.success) continue;
      entries.push(stat.data);
    }
    return ok(entries);
  }

  async exists(absPath: string): Promise<Result<boolean, FileError>> {
    const validated = validateAbsolutePath(absPath);
    if (!validated.success) return validated;

    try {
      await fs.access(validated.data);
      return ok(true);
    } catch (error) {
      if (isFileNotFoundCode((error as NodeJS.ErrnoException).code)) return ok(false);
      return err(classifyFileError(error, validated.data));
    }
  }

  async mkdir(
    absPath: string,
    options: { recursive?: boolean } = {}
  ): Promise<Result<void, FileError>> {
    const validated = validateAbsolutePath(absPath);
    if (!validated.success) return validated;

    try {
      await fs.mkdir(validated.data, { recursive: options.recursive ?? false });
      return ok<void>();
    } catch (error) {
      return err(classifyFileError(error, validated.data));
    }
  }

  async remove(
    absPath: string,
    options: { recursive?: boolean } = {}
  ): Promise<Result<void, FileError>> {
    const validated = validateAbsolutePath(absPath);
    if (!validated.success) return validated;

    try {
      const stat = await fs.lstat(validated.data);
      if (stat.isDirectory()) {
        if (!options.recursive) {
          return err({
            type: 'fs-error',
            path: validated.data,
            message: `Path is a directory: ${validated.data}`,
            code: 'EISDIR',
          });
        }
        await fs.rm(validated.data, { recursive: true, force: true });
        return ok<void>();
      }

      await this.unlinkFile(validated.data);
      return ok<void>();
    } catch (error) {
      return err(classifyFileError(error, validated.data));
    }
  }

  async realPath(absPath: string): Promise<Result<string, FileError>> {
    const validated = validateAbsolutePath(absPath);
    if (!validated.success) return validated;

    try {
      return ok(await fs.realpath(validated.data));
    } catch (error) {
      return err(classifyFileError(error, validated.data));
    }
  }

  async rename(from: string, to: string): Promise<Result<void, FileError>> {
    const validatedFrom = validateAbsolutePath(from);
    if (!validatedFrom.success) return validatedFrom;
    const validatedTo = validateAbsolutePath(to);
    if (!validatedTo.success) return validatedTo;

    try {
      // fs.rename 会静默盖掉已有的目标(POSIX 语义);文件树的「重命名」要的是「名字被占了就说」。
      await fs.lstat(validatedTo.data).then(
        () => {
          throw Object.assign(new Error(`File exists: ${validatedTo.data}`), { code: 'EEXIST' });
        },
        (error: NodeJS.ErrnoException) => {
          if (!isFileNotFoundCode(error.code)) throw error;
        }
      );
      await fs.rename(validatedFrom.data, validatedTo.data);
      return ok<void>();
    } catch (error) {
      return err(classifyFileError(error, validatedTo.data));
    }
  }

  async copyFile(src: string, dest: string): Promise<Result<void, FileError>> {
    const validatedSrc = validateAbsolutePath(src);
    if (!validatedSrc.success) return validatedSrc;
    const validatedDest = validateAbsolutePath(dest);
    if (!validatedDest.success) return validatedDest;

    try {
      await fs.mkdir(path.dirname(validatedDest.data), { recursive: true });
      await fs.copyFile(validatedSrc.data, validatedDest.data);
      const sourceStat = await fs.stat(validatedSrc.data);
      await fs.chmod(validatedDest.data, sourceStat.mode);
      return ok<void>();
    } catch (error) {
      return err(classifyFileError(error, validatedDest.data));
    }
  }

  glob(patterns: string[], options: FileGlobOptions): Result<FileGlob, FileError> {
    const validated = validateGlobArgs(patterns, options);
    if (!validated.success) return validated;
    return ok(this.globPaths(validated.data.patterns, validated.data.cwd, options));
  }

  enumerate(
    absPath: string,
    options: FileEnumerationOptions = {}
  ): Result<FileEnumeration, FileError> {
    const validated = validateAbsolutePath(absPath);
    if (!validated.success) return validated;
    return ok(enumerateFiles(realpathOrResolve(validated.data), options));
  }

  private async writeBuffer(
    absPath: string,
    buffer: Buffer
  ): Promise<Result<WriteFileResult, FileError>> {
    const validated = validateAbsolutePath(absPath);
    if (!validated.success) return validated;

    try {
      await fs.mkdir(path.dirname(validated.data), { recursive: true });
      await fs.writeFile(validated.data, buffer);
      return ok({ bytesWritten: buffer.byteLength });
    } catch (error) {
      return err(classifyFileError(error, validated.data));
    }
  }

  private async unlinkFile(absPath: string): Promise<void> {
    try {
      await fs.unlink(absPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM') throw error;

      await fs.chmod(absPath, 0o666);
      await fs.unlink(absPath);
    }
  }

  private async *globPaths(patterns: string[], cwd: string, options: FileGlobOptions): FileGlob {
    for await (const match of globIterate(patterns, {
      absolute: false,
      cwd,
      dot: options.dot ?? false,
      follow: false,
    })) {
      if (typeof match !== 'string') continue;
      yield path.resolve(cwd, match);
    }
  }
}

function normalizeMaxBytes(maxBytes: number | undefined): number {
  if (maxBytes === undefined) return DEFAULT_MAX_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes < 0) return 0;
  return Math.min(Math.floor(maxBytes), MAX_READ_BYTES);
}

function validateGlobArgs(
  patterns: string[],
  options: FileGlobOptions
): Result<{ patterns: string[]; cwd: string }, FileError> {
  if (patterns.length === 0) {
    return err({
      type: 'invalid-path',
      path: '',
      message: 'At least one glob pattern is required',
    });
  }

  const cwd = validateAbsolutePath(options.cwd);
  if (!cwd.success) return cwd;

  const normalizedPatterns: string[] = [];
  for (const pattern of patterns) {
    if (!pattern) {
      return err({
        type: 'invalid-path',
        path: pattern,
        message: 'Glob pattern must not be empty',
      });
    }
    if (pattern.includes('\0')) {
      return err({ type: 'invalid-path', path: pattern, message: 'Path contains a null byte' });
    }
    normalizedPatterns.push(pattern.replace(/\\/g, '/'));
  }
  return ok({ patterns: normalizedPatterns, cwd: cwd.data });
}
