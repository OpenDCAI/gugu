import { open, stat } from 'node:fs/promises';
import {
  OPENED_FILE_MAX_BYTES,
  REMOTE_WORKSPACE_CHUNK_BYTES,
  type SessionpageOpenedFileChunk,
} from '@gugu/session-core/session-record/contract';

/**
 * 手机点开附件卡(#7193)时,机器这一侧:核对、按块读。
 *
 * 只读这条会话**真的**打开过的文件 —— 由调用方先查宿主的那一份记录(`sessions/session-outputs.ts`)。
 * 这不比桌面多给什么:同一份文件此刻就开在这台电脑的会话旁边。工作区之外也照读,
 * 因为 agent 打开的本来就允许在工作区之外(behavior gugu-plugin「在工作区打开文件」),汇报常在临时目录里。
 */

export class OpenedFileError extends Error {
  constructor(
    readonly code: 'not_opened' | 'file_missing' | 'not_a_file' | 'too_large',
    message: string
  ) {
    super(message);
    this.name = 'OpenedFileError';
  }
}

/** 读一段。`length` 超过一块按一块读;读到文件尾就短。 */
export async function readOpenedFileChunk(path: string, offset: number, length: number): Promise<SessionpageOpenedFileChunk> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new OpenedFileError('file_missing', `文件已经不在了:${path}`);
    throw error;
  });
  if (!info.isFile()) throw new OpenedFileError('not_a_file', `不是一个文件:${path}`);
  if (info.size > OPENED_FILE_MAX_BYTES) {
    throw new OpenedFileError('too_large', `文件 ${info.size} 字节,手机上最多看 ${OPENED_FILE_MAX_BYTES} 字节`);
  }
  const start = Math.max(0, Math.min(Math.floor(offset), info.size));
  const want = Math.max(0, Math.min(Math.floor(length), REMOTE_WORKSPACE_CHUNK_BYTES, info.size - start));
  const buffer = Buffer.alloc(want);
  const handle = await open(path, 'r');
  try {
    const { bytesRead } = await handle.read(buffer, 0, want, start);
    return { size: info.size, etag: `${info.mtimeMs}-${info.size}`, data: buffer.subarray(0, bytesRead).toString('base64') };
  } finally {
    await handle.close();
  }
}
