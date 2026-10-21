import fs from 'node:fs';
import path from 'node:path';
import { isFileNotFoundException } from '@gugu/session-core/files';

export type DirectoryStatus =
  | { kind: 'directory' }
  | { kind: 'not-directory' }
  | { kind: 'inspect-failed'; message: string };

export function getDirectoryStatus(path: string): DirectoryStatus {
  try {
    return fs.statSync(path).isDirectory() ? { kind: 'directory' } : { kind: 'not-directory' };
  } catch (error) {
    if (isFileNotFoundException(error)) return { kind: 'not-directory' };
    return {
      kind: 'inspect-failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function checkIsValidDirectory(path: string): boolean {
  return getDirectoryStatus(path).kind === 'directory';
}

/**
 * 本机项目目录的唯一写法:同一个文件夹只认一种表示。Windows 上 `C:\a\b`、`C:\a/b`、`C:/a/b/`
 * 都是同一个文件夹,逐字节比较会把它们当成三个项目。写库与按路径查项目都过这一个函数。
 * 只用于本机路径;相对路径没有确定的落点,响亮报错,❌ 拿主进程 cwd 去拼。大小写不折叠。
 */
export function projectPathKey(value: string, api: typeof path = path): string {
  if (!api.isAbsolute(value)) throw new Error(`项目目录必须是绝对路径:${value}`);
  return api.resolve(value);
}
