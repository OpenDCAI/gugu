/**
 * #6264 一套工作台:别的电脑打开这台机器上的会话时,工作区里那几件「字节要过线」的事 ——
 * 预览 / 下载按块读、上传按块写(带版本号防覆盖)。文件树、编辑器、git 走的是与本机同一套 `workspace.*` 动词;
 * 只有「把一份任意大小的字节搬到另一台电脑」需要分块(单帧有上限,见 session-host-device-frames.ts)。
 *
 * 边界与本机工作区同一条:路径必须落在这个工作区里,符号链接逃出去也不行(按真实路径再核一次);
 * 写回按「打开时那一版」核对,agent 正在改同一个文件时拒绝,❌ 静默盖掉它的改动。
 */
import { open, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  REMOTE_WORKSPACE_CHUNK_BYTES,
  REMOTE_WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_CONFLICT_CODE,
  WORKSPACE_WRITE_FORCE,
} from '@gugu/session-core/session-record/contract';

export class WorkspaceTransferError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'WorkspaceTransferError';
  }
}

export type WorkspaceChunk = { path: string; size: number; etag: string; offset: number; data: string };
export type WorkspaceWriteChunk = {
  path: string;
  uploadId: string;
  offset: number;
  data: string;
  total: number;
  final: boolean;
  /** 打开时那一版;`WORKSPACE_WRITE_FORCE` = 人确认过覆盖;null = 新文件。 */
  expectedEtag: string | null;
};
export type WorkspaceWriteResult = { received: number; committed?: { etag: string; size: number } };

const UPLOAD_IDLE_MS = 2 * 60_000;

function errnoCode(error: unknown): string {
  return (error as { code?: string } | null)?.code ?? '';
}

function fsError(error: unknown, target: string): WorkspaceTransferError {
  const code = errnoCode(error);
  if (code === 'ENOENT') return new WorkspaceTransferError('not_found', `not found: ${target}`);
  if (code === 'EISDIR') return new WorkspaceTransferError('not_a_file', `not a file: ${target}`);
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new WorkspaceTransferError('permission_denied', `permission denied: ${target}`);
  }
  return new WorkspaceTransferError('internal_error', (error as Error)?.message ?? String(error));
}

/** `candidate` 是不是 `base` 自己或它里面的东西(只按字面;`..` 逃不出去)。 */
export function isInside(base: string, candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  const rel = path.relative(path.resolve(base), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 这一版的标记:纳秒级修改时间 + 大小(同一秒里被 agent 改两次也分得出来)。 */
export function etagOf(info: { mtimeNs: bigint; size: bigint }): string {
  return `${info.mtimeNs.toString()}-${info.size.toString()}`;
}

/** 相对路径按工作区解析;字面在里面还不够,指向外面的符号链接也要挡住(目标还不存在就核它的父目录)。 */
export async function inWorkspace(root: string, target: string): Promise<string> {
  const resolved = path.resolve(root, target);
  if (!isInside(root, resolved)) {
    throw new WorkspaceTransferError('outside_workspace', `path is outside this workspace: ${target}`);
  }
  const realRoot = await realpath(root).catch(() => root);
  const real = await realpath(resolved).catch(async () => {
    const parent = await realpath(path.dirname(resolved)).catch(() => path.dirname(resolved));
    return path.join(parent, path.basename(resolved));
  });
  if (!isInside(realRoot, real)) {
    throw new WorkspaceTransferError('outside_workspace', `path leads outside this workspace: ${target}`);
  }
  return resolved;
}

async function currentEtag(file: string): Promise<string | null> {
  try {
    const info = await stat(file, { bigint: true });
    return info.isFile() ? etagOf(info) : null;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw fsError(error, file);
  }
}

export async function readWorkspaceChunk(
  root: string,
  request: { path: string; offset: number; length: number }
): Promise<WorkspaceChunk> {
  const file = await inWorkspace(root, request.path);
  const offset = Math.max(0, Math.floor(request.offset));
  const length = Math.max(0, Math.min(Math.floor(request.length), REMOTE_WORKSPACE_CHUNK_BYTES));
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    throw fsError(error, file);
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new WorkspaceTransferError('not_a_file', `not a file: ${file}`);
    const size = Number(info.size);
    const want = Math.max(0, Math.min(length, size - offset));
    const buffer = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      const { bytesRead } = await handle.read(buffer, read, want - read, offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return { path: file, size, etag: etagOf(info), offset, data: buffer.subarray(0, read).toString('base64') };
  } catch (error) {
    if (error instanceof WorkspaceTransferError) throw error;
    throw fsError(error, file);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

type PendingUpload = {
  path: string;
  total: number;
  expectedEtag: string | null;
  received: number;
  chunks: Buffer[];
  timer: ReturnType<typeof setTimeout>;
};

/**
 * 按块收一次上传;半截的保存留两分钟等下一段(一次保存的各段带同一个 uploadId)。`maxBytes` 是一份文件的上限(默认工作副本的;
 * 另一台机器发来的 App 包用它自己的,received-packages.ts)。
 */
export function createWorkspaceUploads(options: { idleMs?: number; maxBytes?: number } = {}) {
  const uploads = new Map<string, PendingUpload>();
  const idleMs = options.idleMs ?? UPLOAD_IDLE_MS;
  const maxBytes = options.maxBytes ?? REMOTE_WORKSPACE_MAX_FILE_BYTES;
  const touch = (uploadId: string, upload: PendingUpload) => {
    clearTimeout(upload.timer);
    upload.timer = setTimeout(() => uploads.delete(uploadId), idleMs);
    upload.timer.unref?.();
  };
  return {
    async write(root: string, request: WorkspaceWriteChunk): Promise<WorkspaceWriteResult> {
      const file = await inWorkspace(root, request.path);
      if (!Number.isInteger(request.total) || request.total < 0 || request.total > maxBytes) {
        throw new WorkspaceTransferError('too_large', `file too large to save: ${request.total} bytes`);
      }
      const bytes = Buffer.from(request.data, 'base64');
      if (bytes.length > REMOTE_WORKSPACE_CHUNK_BYTES) throw new WorkspaceTransferError('invalid_payload', 'chunk too large');
      let upload = uploads.get(request.uploadId);
      if (!upload) {
        // 第一段丢了 / 这台机器中途重启过:这次保存接不上,从头再存一遍。
        if (request.offset !== 0) throw new WorkspaceTransferError('upload_lost', 'this save lost its earlier parts; save again');
        upload = {
          path: file,
          total: request.total,
          expectedEtag: request.expectedEtag,
          received: 0,
          chunks: [],
          timer: setTimeout(() => undefined, 0),
        };
        uploads.set(request.uploadId, upload);
      }
      if (upload.path !== file || upload.total !== request.total) {
        throw new WorkspaceTransferError('invalid_payload', 'save parts disagree about the file');
      }
      if (request.offset !== upload.received) {
        throw new WorkspaceTransferError('upload_lost', `expected part at ${upload.received}, got ${request.offset}`);
      }
      if (upload.received + bytes.length > upload.total) {
        throw new WorkspaceTransferError('invalid_payload', 'more bytes than announced');
      }
      touch(request.uploadId, upload);
      upload.chunks.push(bytes);
      upload.received += bytes.length;
      if (!request.final) return { received: upload.received };

      uploads.delete(request.uploadId);
      clearTimeout(upload.timer);
      if (upload.received !== upload.total) {
        throw new WorkspaceTransferError('upload_lost', `received ${upload.received} of ${upload.total} bytes`);
      }
      if (upload.expectedEtag !== WORKSPACE_WRITE_FORCE) {
        const now = await currentEtag(file);
        if (now !== upload.expectedEtag) throw new WorkspaceTransferError(WORKSPACE_CONFLICT_CODE, now ?? '');
      }
      try {
        // 就地写(跟随符号链接、保留权限与属主),与 VS Code 默认的保存方式一致。
        await writeFile(file, Buffer.concat(upload.chunks));
      } catch (error) {
        throw fsError(error, file);
      }
      const info = await stat(file, { bigint: true });
      return { received: upload.received, committed: { etag: etagOf(info), size: Number(info.size) } };
    },
  };
}
