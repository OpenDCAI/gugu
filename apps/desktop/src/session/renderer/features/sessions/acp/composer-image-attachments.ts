/**
 * 输入框里那几枚**图片**附件 chip,从落下到发出去这一路的账本(#5269)。
 *
 * 图片与非图片是两条不同的路:非图片靠正文里的绝对路径(`composer-file-paths.ts`),图片
 * 走 ACP 的附件上传,发送时带的是服务端 ref。这一格最容易静默出错的地方不是上传本身,
 * 而是**两条异步各自回来打补丁**:预览图(FileReader)与上传谁先回来是不定的。
 *
 * ⚠️ 所以这里有一条硬约束:**chip 的 id 从生到死不变**,服务端 ref 记在旁边的表里。
 * 曾经的写法是上传回来把 chip 的 id 换成 `ref.id`,于是预览图那条补丁只要慢一步就落在
 * 一个已经不存在的 id 上、被静默丢掉。而这条赛道是有偏的 —— 文件带磁盘路径时上传只是把
 * 路径递过去,快到必赢,于是「从访达拷来的图」100% 没有缩略图、点开预览也是空的
 * (owner 2026-09-08 实撞)。
 */
import type { AttachmentMimeType, AttachmentRef } from '@gugu/session-core/acp/client';
import type { ComposerAttachment } from '@gugu/session-ui/react/components';
import type { AcpPromptAttachment } from './acp-chat-store';

export interface EnqueueImageAttachmentDeps {
  /** chip 的身份,由调用方给 —— 它同时是 ref 表的键,整条生命周期不变。 */
  chipId: string;
  /** 往 composer 的附件列表上打补丁(React 的 setState updater)。 */
  update: (updater: (prev: ComposerAttachment[]) => ComposerAttachment[]) => void;
  /** 读成 data URL 当缩略图;读不出来就没有缩略图,不影响上传。 */
  readPreview: (file: File) => Promise<string | undefined>;
  upload: (file: File, mimeType: AttachmentMimeType, options: {
    signal?: AbortSignal;
    uploadId: string;
    onProgress: (progress: { sent: number; total?: number }) => void;
  }) => Promise<AttachmentRef | null>;
  signal?: AbortSignal;
  onRetry?: (error: unknown) => void;
  onFailure?: (error: unknown) => void;
  /** 上传成功后把服务端 ref 记进账本 —— 发送与删除都只认它。 */
  rememberRef: (chipId: string, ref: AttachmentRef) => void;
  labels: { uploading: string; failed: string; retrying?: string };
  formatSize: (bytes: number) => string;
}

/**
 * 一枚图片 chip 的全过程:先以 `uploading` 态上条(照 assistant-ui 的 addAttachment 语义,
 * 文件一落下屏幕上就有东西),预览图与上传各自回来时按 `chipId` 打补丁。
 */
export async function enqueueImageAttachment(
  file: File,
  mimeType: AttachmentMimeType,
  deps: EnqueueImageAttachmentDeps
): Promise<void> {
  const { chipId, update, labels } = deps;
  const patch = (next: Partial<ComposerAttachment>) =>
    update((prev) => prev.map((att) => (att.id === chipId ? { ...att, ...next } : att)));

  update((prev) => [
    ...prev,
    {
      id: chipId,
      name: file.name,
      kind: 'image',
      mimeType,
      state: 'uploading',
      cancelable: true,
      meta: labels.uploading,
    },
  ]);

  // 预览图不 await:它只是让 chip 早点有图,不该把上传(以及发送键的解禁)排在它后面。
  void deps.readPreview(file).then((previewUrl) => {
    if (previewUrl) patch({ previewUrl });
  });

  let ref: AttachmentRef | null = null;
  let attempt = 0;
  const uploadId = crypto.randomUUID();
  while (!deps.signal?.aborted) {
    try {
      ref = await deps.upload(file, mimeType, {
        signal: deps.signal,
        uploadId,
        onProgress: ({ sent, total }) => patch({
          progress: total ? Math.min(100, sent / total * 100) : undefined,
        }),
      });
      break;
    } catch (error) {
      if (deps.signal?.aborted) return;
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== 'TIMEOUT' && code !== 'DISCONNECTED') { deps.onFailure?.(error); break; }
      deps.onRetry?.(error);
      patch({ progress: undefined, meta: labels.retrying ?? labels.uploading });
      await retryDelay(Math.min(10_000, 250 * 2 ** Math.min(attempt++, 6)), deps.signal);
    }
  }
  if (deps.signal?.aborted) return;
  if (!ref) {
    patch({ state: 'error', progress: undefined, cancelable: undefined, meta: labels.failed });
    return;
  }
  deps.rememberRef(chipId, ref);
  patch({ name: ref.name, mimeType: ref.mimeType, state: 'done', progress: undefined, cancelable: undefined, meta: deps.formatSize(file.size) });
}

function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * 这一轮要随 prompt 发出去的图片附件。
 *
 * 判据是「账本里有没有它的 ref」,❌ 不是 chip 上的 `state` —— 同一件事有两个真相来源,
 * 漂开只是时间问题。上传中与失败的从来没进过账本,自然不会被发出去。
 */
export function imagePromptAttachments(
  attachments: readonly ComposerAttachment[],
  refs: ReadonlyMap<string, AttachmentRef>
): AcpPromptAttachment[] {
  return attachments.flatMap((att) => {
    const ref = refs.get(att.id);
    if (!ref) return [];
    return [
      {
        ref: { type: 'attachment' as const, id: ref.id, mimeType: ref.mimeType, name: ref.name },
        previewUrl: att.previewUrl,
      },
    ];
  });
}

/**
 * chip 被 × 掉之后,服务端该跟着删掉哪几件。
 *
 * 只认账本:上传中/失败的 chip 在服务端根本不存在,拿它的本地 id 去删只会 404。
 */
export function droppedImageRefs(
  refs: ReadonlyMap<string, AttachmentRef>,
  remainingChipIds: ReadonlySet<string>
): { chipId: string; ref: AttachmentRef }[] {
  return [...refs.entries()]
    .filter(([chipId]) => !remainingChipIds.has(chipId))
    .map(([chipId, ref]) => ({ chipId, ref }));
}

/**
 * 一张图该走哪条路:ACP 附件上传,还是退回「正文里的绝对路径」(非图片文件一直走的那条)。
 *
 * 判据是 agent 在 `initialize` 里**声明**的 `promptCapabilities.image`,❌ 不是「它是哪一家」。
 * 收不下图片的一端会静默把 image 块丢掉 —— 用户那边看到的是「附件在,模型说看不见」,
 * 产品面上没有任何异常可循(#5269)。所以宁可降级成一条路径:内容仍到得了 agent(它能自己去读),
 * 而且降级在 chip 上写着,是看得见的。
 *
 * `null` = 会话还没起来,能力未知 ⇒ **不改行为**,照走上传。那条路真发不出去时会响亮变红,
 * 而这里若擅自降级,收图正常的那几家会在会话启动的头几秒里被无声地降一档。
 */
export function imageAttachmentRoute(acceptsImagePrompts: boolean | null): 'upload' | 'path' {
  return acceptsImagePrompts === false ? 'path' : 'upload';
}
