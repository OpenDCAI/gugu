/**
 * 输入框里一件文件 / 文件夹附件,从落下到「agent 拿得到的那条路径」这一路(#5269、#6264)。
 *
 * 会话在哪台机器上,字节就先传到哪台机器(照 VS Code 远程:先上传,再附那台机器上的路径)——
 * 本机会话落进本机的任务附件目录,别的机器上的会话经那台机器的连接一块块送过去(远程 SSH 的机器走 SSH,
 * 远程隧道的机器走咕咕云,由 `rpc.sessionCreate.*` 按任务所在的机器选线,这里不分)。
 *
 * product spec:贴上来就开始传、进度在附件上、发送时没传完就等、失败在附件上说明并可重传。
 * 那几件界面上的事在 acp-chat-panel.tsx;这里只有传输本身与失败分类,rpc 注入,单测钉每条分支。
 */
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_FOLDER_FILES, REMOTE_WORKSPACE_CHUNK_BYTES } from '@gugu/session-core/session-record/contract';

/** 文件夹里的一件:从文件夹名起的逐层名字 + 按段取字节。 */
export type UploadPiece = {
  segments: string[];
  size: number;
  slice(start: number, end: number): Promise<Uint8Array>;
};

export type UploadSource =
  | {
      kind: 'file';
      name: string;
      mimeType?: string;
      /** 用户自己盘上那个文件(本机会话、从访达拖进来的才有):只决定 mention 指向谁。 */
      originalPath?: string;
      size: number;
      slice(start: number, end: number): Promise<Uint8Array>;
    }
  | { kind: 'folder'; name: string; pieces: UploadPiece[] };

/** 那台机器落好的一件(与 `stageAttachment` 返回的同形)。 */
export type CommittedAttachment = {
  id: string;
  storedPath: string;
  originalPath?: string;
  /** 发给 agent 的 mention 指向谁。 */
  mentionPath: string;
  name: string;
  mimeType?: string;
  size: number;
};

export type RpcResult<T> = { success: true; data: T } | { success: false; error: { type: string; message?: string } };

/** `rpc.sessionCreate` 里这三条(按任务所在的机器路由)。 */
export type AttachmentUploadRpc = {
  writeAttachmentChunk(chunk: {
    sessionId: string;
    uploadId: string;
    segments: string[];
    offset: number;
    data: Uint8Array;
    total: number;
  }): Promise<RpcResult<{ received: number }>>;
  commitAttachmentUpload(commit: {
    sessionId: string;
    uploadId: string;
    kind: 'file' | 'folder';
    name: string;
    mimeType?: string;
    originalPath?: string;
    record?: boolean;
  }): Promise<RpcResult<CommittedAttachment>>;
  discardAttachmentUpload(input: { sessionId: string; uploadId: string }): Promise<RpcResult<void>>;
};

export type UploadFailureReason =
  /** 超过附件上限(与本机同一个数):重试也不会好。 */
  | 'too-large'
  /** 那台机器上的咕咕 server 还不认按块收附件;它空闲时会自己更新。 */
  | 'server-too-old'
  /** 其它(连不上、断了、那台机器写盘失败…):原文进日志,可重试。 */
  | 'failed';

export class AttachmentUploadFailure extends Error {
  constructor(
    readonly reason: UploadFailureReason,
    readonly detail: string
  ) {
    super(`attachment upload failed: ${reason} (${detail})`);
    this.name = 'AttachmentUploadFailure';
  }

  get retryable(): boolean {
    return this.reason !== 'too-large';
  }
}

export class AttachmentUploadCancelled extends Error {
  constructor() {
    super('attachment upload cancelled');
    this.name = 'AttachmentUploadCancelled';
  }
}

export function sourceSize(source: UploadSource): number {
  return source.kind === 'file' ? source.size : source.pieces.reduce((sum, piece) => sum + piece.size, 0);
}

/** 传输层抛出来的(那台机器不认这个动词 = 太旧;其它一律「没传上去」)。 */
function classify(error: unknown): AttachmentUploadFailure {
  if (error instanceof AttachmentUploadFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/No handler registered/.test(message)) return new AttachmentUploadFailure('server-too-old', message);
  return new AttachmentUploadFailure('failed', message);
}

function unwrap<T>(result: RpcResult<T>): T {
  if (result.success) return result.data;
  const reason = result.error.type === 'too_large' || result.error.type === 'too_many_files' ? 'too-large' : 'failed';
  throw new AttachmentUploadFailure(reason, result.error.message ?? result.error.type);
}

/**
 * 传一件,返回那台机器落好的记录(`mentionPath` 是发给 agent 的那条路径)。`onProgress(已传, 总共)` 每块报一次;`signal` 中止 = 取消并清掉已传的部分。
 */
export async function uploadComposerAttachment(args: {
  rpc: AttachmentUploadRpc;
  sessionId: string;
  uploadId: string;
  source: UploadSource;
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
  /** false = 只落盘不登记(新建会话页,任务还没建出来)。 */
  record?: boolean;
  maxBytes?: number;
  chunkBytes?: number;
}): Promise<CommittedAttachment> {
  const { rpc, sessionId, uploadId, source, signal } = args;
  const total = sourceSize(source);
  const maxBytes = args.maxBytes ?? MAX_ATTACHMENT_BYTES;
  // 先说超限,❌ 传完一大半才被那台机器拒。
  if (total > maxBytes) throw new AttachmentUploadFailure('too-large', `${total} > ${maxBytes}`);
  if (source.kind === 'folder' && source.pieces.length > MAX_ATTACHMENT_FOLDER_FILES) {
    throw new AttachmentUploadFailure('too-large', `${source.pieces.length} files > ${MAX_ATTACHMENT_FOLDER_FILES}`);
  }
  const chunkBytes = args.chunkBytes ?? REMOTE_WORKSPACE_CHUNK_BYTES;
  const pieces: UploadPiece[] = source.kind === 'file' ? [{ segments: [source.name], size: source.size, slice: source.slice }] : source.pieces;
  let sent = 0;
  const check = () => {
    if (signal?.aborted) throw new AttachmentUploadCancelled();
  };
  try {
    args.onProgress?.(0, total);
    for (const piece of pieces) {
      let offset = 0;
      // 空文件也要写一次,那台机器上才有这个文件。
      do {
        check();
        const end = Math.min(piece.size, offset + chunkBytes);
        const data = await piece.slice(offset, end);
        check();
        unwrap(await rpc.writeAttachmentChunk({ sessionId, uploadId, segments: piece.segments, offset, data, total: piece.size }));
        offset = end;
        sent += data.byteLength;
        args.onProgress?.(sent, total);
      } while (offset < piece.size);
    }
    check();
    const committed = unwrap<CommittedAttachment>(
      await rpc.commitAttachmentUpload({
        sessionId,
        uploadId,
        kind: source.kind,
        name: source.name,
        ...(source.kind === 'file' && source.mimeType ? { mimeType: source.mimeType } : {}),
        ...(source.kind === 'file' && source.originalPath ? { originalPath: source.originalPath } : {}),
        ...(args.record === false ? { record: false } : {}),
      })
    );
    return committed;
  } catch (error) {
    // 半途而废的那一份不留在那台机器上(取消、失败都清;清不掉也不改原因)。
    void rpc.discardAttachmentUpload({ sessionId, uploadId }).catch(() => undefined);
    if (error instanceof AttachmentUploadCancelled) throw error;
    throw classify(error);
  }
}
