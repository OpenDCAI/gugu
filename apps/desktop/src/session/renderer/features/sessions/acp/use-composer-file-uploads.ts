/**
 * 任务输入框里那一排附件 chip(图片与文件同一条,P3):每一件放进这个 agent 私聊的文件夹(不发消息),
 * 这一轮带着它们的引用(`TurnFileRef`)发出去。
 * product spec:**贴上来就开始放**,进度写在 chip 上;× 掉 = 取消(已经放进文件夹的那份留着也无妨);
 * 失败在 chip 上说、能重试;发送时还没放完就等(`waitForUploads`),有一件没成就不发。
 * 放到哪由 `placeTaskAttachment` 定(桌面:本机发布,按需取;手机 / 网页:上传进文件夹)。
 */
import type { ComposerAttachment } from '@gugu/session-ui/react/components';
import type { TurnFileRef } from '@gugu/session-core/session-record/contract';
import { AttachmentsError } from '@gugu/core/cloud/attachmentsApi';
import { useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import { placeTaskAttachment, prepareTaskAttachment, type TaskAttachmentPlacement } from '@/lib/attachmentsEndpoint';
import { selectedScreenshot, screenshotQuality, toggleScreenshotQuality, retryScreenshot, screenshotPreview } from '@/lib/pastedScreenshot';
import { formatBytes } from '@renderer/utils/formatBytes';
import { log } from '@renderer/utils/logger';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';

type Translate = (key: SessionMessageLookupKey, values?: Record<string, string | number>) => string;
/** 附件放进哪个私聊、以谁的身份放。 */
export type { TaskAttachmentTarget } from '@/lib/taskAttachmentTarget';
import type { TaskAttachmentTarget } from '@/lib/taskAttachmentTarget';

type Upload = { placement: TaskAttachmentPlacement; file: File; controller: AbortController; settled: Promise<boolean>; ref: TurnFileRef | null; status: 'running' | 'done' | 'failed'; confirmed: number; total: number };

function progressMeta(sent: number, total: number): string {
  const percent = total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 100;
  return `${formatBytes(sent)} / ${formatBytes(total)} · ${percent}%`;
}

type ComposerFileUploadArgs = {
  /** 这个 agent 的私聊:第一次放附件时才问,只问一次(问失败了下一次再问)。 */
  to: () => Promise<TaskAttachmentTarget>;
  setAttachments: Dispatch<SetStateAction<ComposerAttachment[]>>;
  translate: Translate;
  /** Existing-session composers opt into durable SSH uploads; creation keeps its own flow. */
  resumable?: boolean;
};

/** One placement implementation, owned either by the live composer or a submitted request. */
function readFileAsDataUrl(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

export function createComposerFileUploads(readArgs: () => ComposerFileUploadArgs) {
  // 回调要稳定(输入框的 props 靠它们),参数每次渲染都新:取用时读最新的那份。
  const uploads = new Map<string, Upload>();
  const target: { current: Promise<TaskAttachmentTarget> | null } = { current: null };
  // 每一件先「定名」(桌面:它在文件夹里的 id + agent 要用的那个文件),再放:新建任务的首轮在私聊还没有之前
  // 就得写出它们(prepareTaskAttachment)。定名失败就忘掉,重试时再定一次。
  const named = new Map<string, Promise<TurnFileRef | null>>();
  const nameOf = ((chipId: string, file: File) => {
    let ref = named.get(chipId);
    if (!ref) {
      ref = (readArgs().resumable ? selectedScreenshot(file) : Promise.resolve(file)).then(prepareTaskAttachment);
      named.set(chipId, ref);
      ref.catch(() => { if (named.get(chipId) === ref) named.delete(chipId); });
    }
    return ref;
  });

  const patch = (
    (chipId: string, next: Partial<ComposerAttachment>) =>
      readArgs().setAttachments((prev) => prev.map((att) => (att.id === chipId ? { ...att, ...next } : att)))
  );

  const start = (chipId: string, file: File) => {
    const controller = new AbortController();
    const previous = uploads.get(chipId);
    const placement = previous?.placement ?? {};
    const retained = placement.upload?.started && !placement.upload.restartRequired;
    const upload: Upload = { placement, file, controller, settled: Promise.resolve(false), ref: null, status: 'running', confirmed: retained ? previous?.confirmed ?? 0 : 0, total: previous?.total ?? file.size };
    uploads.set(chipId, upload);
    const active = () => !controller.signal.aborted && uploads.get(chipId) === upload;
    const quality = readArgs().resumable ? screenshotQuality(file) : undefined;
    patch(chipId, { imageQuality: quality, state: 'uploading', progress: retained ? (upload.total ? 100 * upload.confirmed / upload.total : 100) : !previous && quality === 'compressed' ? undefined : 0,
      cancelable: true, retryable: undefined, meta: retained ? progressMeta(upload.confirmed, upload.total) : !previous && quality === 'compressed' ? readArgs().translate('composer.screenshotPreparing') : progressMeta(0, file.size) });
    const to = (target.current ??= readArgs().to().catch((error: unknown) => { target.current = null; throw error; }));
    let selected = file;
    let phase: 'uploading' | 'resuming' | 'confirming' = 'uploading';
    let received = upload.confirmed, total = upload.total;
    const progress = () => {
      if (!active()) return;
      const suffix = phase === 'uploading' ? '' : ` · ${readArgs().translate(phase === 'resuming' ? 'composer.attachmentResuming' : 'composer.attachmentConfirming')}`;
      patch(chipId, { progress: total > 0 ? Math.min(100, (received / total) * 100) : 100, meta: progressMeta(received, total) + suffix });
    };
    upload.settled = Promise.all([readArgs().resumable ? selectedScreenshot(file) : Promise.resolve(file), to]).then(async ([source, destination]) => {
      controller.signal.throwIfAborted();
      selected = source;
      total = source.size;
      const previewUrl = quality ? await screenshotPreview(source) : undefined;
      controller.signal.throwIfAborted();
      if (active()) patch(chipId, { name: source.name, mimeType: source.type, ...(previewUrl ? { previewUrl } : {}) });
      progress();
      const prepared = await nameOf(chipId, file);
      controller.signal.throwIfAborted();
      return placeTaskAttachment(source, prepared, destination, (sent, all) => {
        received = sent; total = all; upload.confirmed = sent; upload.total = all; progress();
      }, { signal: controller.signal, placement, ...(readArgs().resumable ? { resumable: true, onPhase: (next: typeof phase) => { phase = next; progress(); } } : {}) });
    }).then((ref) => {
      if (!active()) return false;
      upload.ref = ref;
      upload.status = 'done';
      patch(chipId, { state: 'done', progress: undefined, cancelable: undefined, meta: formatBytes(selected.size) + (quality ? ` · ${readArgs().translate(selected === file ? 'composer.screenshotOriginal' : 'composer.screenshotCompressed')}` : '') });
      return true;
    }, (error: unknown) => {
      upload.status = 'failed';
      if (!active()) return false;
      log.warn('composer attachment placement failed', { name: file.name, error: String(error) });
      const tooLarge = error instanceof AttachmentsError && error.code === 'too_large';
      const code = (error as { code?: string })?.code;
      const key = code === 'transfer_disabled' ? 'composer.attachmentTransferDisabled'
        : code === 'host_update_required' ? 'composer.attachmentHostUpdateRequired'
        : code === 'task_identity_missing' ? 'composer.attachmentIdentityRequired'
        : code === 'upload_lost' || code === 'upload_expired' ? 'composer.attachmentUploadExpired'
        : code === 'screenshot_processing_failed' ? 'composer.screenshotFailed'
        : tooLarge ? 'composer.attachmentTooLarge' : 'composer.attachmentUploadFailed';
      patch(chipId, { state: 'error', progress: undefined, cancelable: undefined,
        meta: readArgs().translate(key), retryable: !tooLarge && code !== 'task_identity_missing' });
      return false;
    });
    return upload.settled;
  };

  const toggleQuality = (chipId: string) => {
    const upload = uploads.get(chipId);
    if (!upload || !readArgs().resumable || !screenshotQuality(upload.file)) return;
    upload.controller.abort();
    uploads.delete(chipId);
    named.delete(chipId);
    toggleScreenshotQuality(upload.file);
    void start(chipId, upload.file);
  };

  /** 上一枚 chip(已经在条上的就地接着用)并立刻开始放。 */
  const add = (
    (chip: ComposerAttachment, file: File) => {
      const placing = { ...chip, state: 'uploading' as const, progress: 0, cancelable: true };
      readArgs().setAttachments((prev) => prev.some((att) => att.id === chip.id)
        ? prev.map((att) => (att.id === chip.id ? placing : att))
        : [...prev, placing]);
      // 粘贴的截图由 start 按选中的那份出预览;其余还没有预览的图片在这里读一份缩略图。
      if (chip.kind === 'image' && !chip.previewUrl && !screenshotQuality(file)) void readFileAsDataUrl(file).then((previewUrl) => { if (previewUrl) patch(chip.id, { previewUrl }); });
      return start(chip.id, file);
    }
  );

  const retry = (
    (chipId: string) => {
      const upload = uploads.get(chipId);
      if (upload?.status === 'failed') { retryScreenshot(upload.file); void start(chipId, upload.file); }
    }
  );

  /** 输入框报来的剩下那几枚:不在里面的不再管(还在放就取消)。 */
  const keepOnly = ((ids: ReadonlySet<string>) => {
    for (const [chipId, upload] of uploads) {
      if (ids.has(chipId)) continue;
      upload.controller.abort();
      uploads.delete(chipId);
    }
    for (const chipId of named.keys()) if (!ids.has(chipId)) named.delete(chipId);
  });

  /**
   * 新建任务的首轮(P3):这几件还没放,先定名 —— 正文里写的就是它们放好之后的 id 与本机路径。
   * 有一件定不了名(手机 / 网页没有本机文件可给;或写副本失败)→ null。
   */
  const prepare = (async (chips: ReadonlyArray<{ id: string; file: File }>): Promise<TurnFileRef[] | null> => {
    const refs = await Promise.all(chips.map(({ id, file }) => nameOf(id, file).catch(() => null)));
    return refs.every((ref): ref is TurnFileRef => ref !== null) ? refs : null;
  });

  /** 发送前:等还在放的放完。全都成了 → true。 */
  const waitForUploads = (async (): Promise<boolean> => {
    const results = await Promise.all([...uploads.values()].map((upload) => upload.settled));
    return results.every(Boolean);
  });

  /** 有没有还没放成的(放着的、失败的)—— 没有就不必等,直接发。 */
  const unsettled = (() => [...uploads.values()].some((upload) => upload.status !== 'done'));

  /** 这几枚 chip 放好的引用,按给的顺序(这一轮带走的就是它们)。 */
  const files = (
    (chipIds: readonly string[]): TurnFileRef[] => chipIds.flatMap((id) => {
      const ref = uploads.get(id)?.ref;
      return ref ? [ref] : [];
    })
  );

  /** 这一枚发出去了 / 不要了:不再管(还在放就取消)。 */
  const forget = ((chipId: string) => {
    uploads.get(chipId)?.controller.abort();
    uploads.delete(chipId);
    named.delete(chipId);
  });

  /** 这枚 chip 是不是这里在管(放着、放好、失败)。 */
  const has = ((chipId: string) => uploads.has(chipId));

  /** 发出去了:账清空(文件留在私聊文件夹里,这一轮的引用指着它们);私聊下次再问。 */
  const clear = (() => {
    for (const upload of uploads.values()) upload.controller.abort();
    uploads.clear();
    named.clear();
    target.current = null;
  });

  return { add, retry, toggleQuality, keepOnly, prepare, waitForUploads, unsettled, files, has, forget, clear };
}

export function useComposerFileUploads(args: ComposerFileUploadArgs) {
  const latest = useRef(args);
  latest.current = args;
  return useMemo(() => createComposerFileUploads(() => latest.current), []);
}
