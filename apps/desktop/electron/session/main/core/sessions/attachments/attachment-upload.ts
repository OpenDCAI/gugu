/**
 * 输入框附件按块收下(#6264:别的机器上的会话照样能带附件,照 VS Code「先传到那台机器、再附那台机器上的路径」)。
 *
 * 附件的字节可能来自另一台电脑(看界面的那台),经会话页宿主协议一块块送来 —— 远程 SSH 的机器走 SSH,
 * 远程隧道的机器走咕咕云,由连接本身决定,这里不管。本机会话走的也是这同一条:贴上来就开始传、
 * 进度一块块报、中途可取消,落成与一次性存一份(`stageSessionAttachment`)完全相同的记录。
 *
 * 分三步:
 *  · `writeSessionAttachmentChunk` —— 一块写进 `<任务附件目录>/.incoming/<uploadId>/<逐层名字>`(按偏移续写,
 *    偏移对不上就拒绝,❌ 默默拼出一份错位的文件);
 *  · `commitSessionAttachmentUpload` —— 传齐了:文件交给 `stageSessionAttachment`(命名、HEIC 转 PNG 同一套),
 *    文件夹整棵挪到 `<任务附件目录>/<id>/<文件夹名>`;登记进库;返回发给 agent 的那条路径;
 *  · `discardSessionAttachmentUpload` —— 人把它 × 掉了:清掉已传的部分。
 *
 * 上限与本机附件同一个数(`MAX_DROPPED_BLOB_BYTES`,文件夹按总量算),文件夹最多 `MAX_ATTACHMENT_FOLDER_FILES` 个文件。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_ATTACHMENT_FOLDER_FILES } from '@gugu/session-core/session-record/contract';
import { MAX_DROPPED_BLOB_BYTES } from '@main/core/pty/persist-dropped-blob';
import {
  recordSessionAttachments,
  stageSessionAttachment,
  sessionAttachmentDirectory,
  type StagedSessionAttachment,
} from './session-attachment-store';

/** 传了一半的放这儿;启动时的清扫器(session-attachment-store.ts)按这个名字清。 */
export const INCOMING_ATTACHMENTS_DIRECTORY = '.incoming';

export class AttachmentUploadError extends Error {
  constructor(
    readonly code: 'bad_request' | 'offset_mismatch' | 'too_large' | 'too_many_files' | 'not_found',
    message: string
  ) {
    super(message);
    this.name = 'AttachmentUploadError';
  }
}

export type AttachmentChunk = {
  sessionId: string;
  uploadId: string;
  /** 落点起的逐层名字:单个文件 `[名字]`,文件夹里的 `[文件夹名, 子目录…, 文件名]`。 */
  segments: string[];
  offset: number;
  data: Uint8Array;
  /** 这个文件的总字节数。 */
  total: number;
};

export type AttachmentCommit = {
  sessionId: string;
  uploadId: string;
  kind: 'file' | 'folder';
  name: string;
  mimeType?: string;
  /** 用户自己盘上那个文件(本机拖进来的才有):只决定 mention 指向谁,见 `stageSessionAttachment`。 */
  originalPath?: string;
  /**
   * false = 只落盘不登记(新建会话页:任务还没建出来,外键插不进去;建好后经 `recordAttachments` 补)。
   * 缺省登记。
   */
  record?: boolean;
};

const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

function checkIds(sessionId: string, uploadId: string): void {
  if (!SAFE_ID.test(uploadId) || !sessionId || /[/\\]|\.\./.test(sessionId)) {
    throw new AttachmentUploadError('bad_request', 'bad upload id');
  }
}

/** 一层名字:不许空、不许 `.`/`..`、不许带分隔符 —— 逃不出这次上传的目录。 */
function checkSegments(segments: readonly string[]): void {
  if (segments.length === 0 || segments.length > 64) throw new AttachmentUploadError('bad_request', 'bad path');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.length > 255 || /[/\\\0]/.test(segment)) {
      throw new AttachmentUploadError('bad_request', `bad path segment: ${segment}`);
    }
  }
}

function uploadDirectory(sessionId: string, uploadId: string, userDataDir?: string): string {
  return join(sessionAttachmentDirectory(sessionId, userDataDir), INCOMING_ATTACHMENTS_DIRECTORY, uploadId);
}

export async function writeSessionAttachmentChunk(
  chunk: AttachmentChunk,
  userDataDir?: string
): Promise<{ received: number }> {
  checkIds(chunk.sessionId, chunk.uploadId);
  checkSegments(chunk.segments);
  const offset = Math.floor(chunk.offset);
  if (offset < 0 || chunk.total > MAX_DROPPED_BLOB_BYTES || offset + chunk.data.byteLength > chunk.total) {
    throw new AttachmentUploadError('too_large', `attachment is larger than ${MAX_DROPPED_BLOB_BYTES} bytes`);
  }
  const file = join(uploadDirectory(chunk.sessionId, chunk.uploadId, userDataDir), ...chunk.segments);
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  if (offset > 0) {
    const have = await stat(file).then((info) => info.size, () => -1);
    if (have !== offset) throw new AttachmentUploadError('offset_mismatch', `expected offset ${have}, got ${offset}`);
  }
  const handle = await open(file, offset === 0 ? 'w' : 'r+', 0o600);
  try {
    await handle.write(chunk.data, 0, chunk.data.byteLength, offset);
  } finally {
    await handle.close();
  }
  return { received: offset + chunk.data.byteLength };
}

/** 文件夹里一共多少字节、多少个文件(超了就早停)。 */
async function measure(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(full)).size;
      }
      if (files > MAX_ATTACHMENT_FOLDER_FILES || bytes > MAX_DROPPED_BLOB_BYTES) return;
    }
  };
  await walk(dir);
  return { bytes, files };
}

export async function commitSessionAttachmentUpload(
  commit: AttachmentCommit,
  userDataDir?: string
): Promise<StagedSessionAttachment> {
  checkIds(commit.sessionId, commit.uploadId);
  checkSegments([commit.name]);
  const incoming = uploadDirectory(commit.sessionId, commit.uploadId, userDataDir);
  const source = join(incoming, commit.name);
  try {
    if (commit.kind === 'file') {
      const bytes = await readFile(source).catch(() => {
        throw new AttachmentUploadError('not_found', 'nothing was uploaded under this id');
      });
      const staged = await stageSessionAttachment(
        {
          sessionId: commit.sessionId,
          name: commit.name,
          mimeType: commit.mimeType,
          size: bytes.byteLength,
          bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          ...(commit.originalPath ? { originalPath: commit.originalPath } : {}),
        },
        userDataDir
      );
      if (commit.record !== false) await recordSessionAttachments(commit.sessionId, [staged]);
      return staged;
    }
    const exists = await stat(source).then((info) => info.isDirectory(), () => false);
    if (!exists) throw new AttachmentUploadError('not_found', 'nothing was uploaded under this id');
    const { bytes, files } = await measure(source);
    if (files > MAX_ATTACHMENT_FOLDER_FILES) throw new AttachmentUploadError('too_many_files', `more than ${MAX_ATTACHMENT_FOLDER_FILES} files`);
    if (bytes > MAX_DROPPED_BLOB_BYTES) throw new AttachmentUploadError('too_large', `folder is larger than ${MAX_DROPPED_BLOB_BYTES} bytes`);
    const id = randomUUID();
    const home = join(sessionAttachmentDirectory(commit.sessionId, userDataDir), id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    // 文件夹保留原名(agent 读到的就是用户拖进来的那个名字),外面套一层 id 防重名。
    const target = join(home, commit.name);
    await rename(source, target);
    const staged: StagedSessionAttachment = {
      id,
      storedPath: target,
      mentionPath: target,
      name: commit.name,
      mimeType: 'inode/directory',
      size: bytes,
    };
    if (commit.record !== false) await recordSessionAttachments(commit.sessionId, [staged]);
    return staged;
  } finally {
    await rm(incoming, { recursive: true, force: true });
  }
}

export async function discardSessionAttachmentUpload(
  input: { sessionId: string; uploadId: string },
  userDataDir?: string
): Promise<void> {
  checkIds(input.sessionId, input.uploadId);
  await rm(uploadDirectory(input.sessionId, input.uploadId, userDataDir), { recursive: true, force: true });
}
