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
import { useCallback, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import { placeTaskAttachment, prepareTaskAttachment, type TaskAttachmentPlacement } from '@/lib/attachmentsEndpoint';
import { formatBytes } from '@renderer/utils/formatBytes';
import { log } from '@renderer/utils/logger';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';

type Translate = (key: SessionMessageLookupKey, values?: Record<string, string | number>) => string;
/** 附件放进哪个私聊、以谁的身份放。 */
export type { TaskAttachmentTarget } from '@/lib/taskAttachmentTarget';
import type { TaskAttachmentTarget } from '@/lib/taskAttachmentTarget';

type Upload = { placement: TaskAttachmentPlacement; file: File; controller: AbortController; settled: Promise<boolean>; ref: TurnFileRef | null; status: 'running' | 'done' | 'failed' };

function progressMeta(sent: number, total: number): string {
  const percent = total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 100;
  return `${formatBytes(sent)} / ${formatBytes(total)} · ${percent}%`;
}

export function useComposerFileUploads(args: {
  /** 这个 agent 的私聊:第一次放附件时才问,只问一次(问失败了下一次再问)。 */
  to: () => Promise<TaskAttachmentTarget>;
  setAttachments: Dispatch<SetStateAction<ComposerAttachment[]>>;
  translate: Translate;
}) {
  // 回调要稳定(输入框的 props 靠它们),参数每次渲染都新:取用时读最新的那份。
  const latest = useRef(args);
  latest.current = args;
  const uploads = useRef(new Map<string, Upload>());
  const target = useRef<Promise<TaskAttachmentTarget> | null>(null);
  // 每一件先「定名」(桌面:它在文件夹里的 id + agent 要用的那个文件),再放:新建任务的首轮在私聊还没有之前
  // 就得写出它们(prepareTaskAttachment)。定名失败就忘掉,重试时再定一次。
  const named = useRef(new Map<string, Promise<TurnFileRef | null>>());
  const nameOf = useCallback((chipId: string, file: File) => {
    let ref = named.current.get(chipId);
    if (!ref) {
      ref = prepareTaskAttachment(file);
      named.current.set(chipId, ref);
      ref.catch(() => { if (named.current.get(chipId) === ref) named.current.delete(chipId); });
    }
    return ref;
  }, []);

  const patch = useCallback(
    (chipId: string, next: Partial<ComposerAttachment>) =>
      latest.current.setAttachments((prev) => prev.map((att) => (att.id === chipId ? { ...att, ...next } : att))),
    []
  );

  const start = useCallback(
    (chipId: string, file: File) => {
      const controller = new AbortController();
      const placement = uploads.current.get(chipId)?.placement ?? {};
      const upload: Upload = { placement, file, controller, settled: Promise.resolve(false), ref: null, status: 'running' };
      patch(chipId, { state: 'uploading', progress: 0, cancelable: true, retryable: undefined, meta: progressMeta(0, file.size) });
      const to = (target.current ??= latest.current.to().catch((error: unknown) => { target.current = null; throw error; }));
      const settled = Promise.all([nameOf(chipId, file), to])
        .then(([prepared, destination]) => placeTaskAttachment(file, prepared, destination, (sent, all) => {
          if (!controller.signal.aborted) patch(chipId, { progress: all > 0 ? Math.min(100, (sent / all) * 100) : 100, meta: progressMeta(sent, all) });
        }, { signal: controller.signal, placement }))
        .then(
          (ref) => {
            if (controller.signal.aborted) return false;
            upload.ref = ref;
            upload.status = 'done';
            patch(chipId, { state: 'done', progress: undefined, cancelable: undefined, meta: formatBytes(file.size) });
            return true;
          },
          (error: unknown) => {
            upload.status = 'failed';
            if (controller.signal.aborted) return false;
            // 原文进日志;chip 上只有人话。超过存储的上限(那一层自己拒)重试也不会好。
            log.warn('composer attachment placement failed', { name: file.name, error: String(error) });
            const tooLarge = error instanceof AttachmentsError && error.code === 'too_large';
            const code = (error as { code?: string })?.code;
            const key = code === 'transfer_disabled' ? 'composer.attachmentTransferDisabled'
              : code === 'host_update_required' ? 'composer.attachmentHostUpdateRequired'
              : code === 'task_identity_missing' ? 'composer.attachmentIdentityRequired'
              : tooLarge ? 'composer.attachmentTooLarge' : 'composer.attachmentUploadFailed';
            patch(chipId, { state: 'error', progress: undefined, cancelable: undefined,
              meta: latest.current.translate(key), retryable: !tooLarge && code !== 'task_identity_missing' });
            return false;
          }
        );
      upload.settled = settled;
      uploads.current.set(chipId, upload);
      return settled;
    },
    [nameOf, patch]
  );

  /** 上一枚 chip(已经在条上的就地接着用)并立刻开始放。 */
  const add = useCallback(
    (chip: ComposerAttachment, file: File) => {
      const placing = { ...chip, state: 'uploading' as const, progress: 0, cancelable: true };
      latest.current.setAttachments((prev) => prev.some((att) => att.id === chip.id)
        ? prev.map((att) => (att.id === chip.id ? placing : att))
        : [...prev, placing]);
      return start(chip.id, file);
    },
    [start]
  );

  const retry = useCallback(
    (chipId: string) => {
      const upload = uploads.current.get(chipId);
      if (upload?.status === 'failed') void start(chipId, upload.file);
    },
    [start]
  );

  /** 输入框报来的剩下那几枚:不在里面的不再管(还在放就取消)。 */
  const keepOnly = useCallback((ids: ReadonlySet<string>) => {
    for (const [chipId, upload] of uploads.current) {
      if (ids.has(chipId)) continue;
      upload.controller.abort();
      uploads.current.delete(chipId);
    }
    for (const chipId of named.current.keys()) if (!ids.has(chipId)) named.current.delete(chipId);
  }, []);

  /**
   * 新建任务的首轮(P3):这几件还没放,先定名 —— 正文里写的就是它们放好之后的 id 与本机路径。
   * 有一件定不了名(手机 / 网页没有本机文件可给;或写副本失败)→ null。
   */
  const prepare = useCallback(async (chips: ReadonlyArray<{ id: string; file: File }>): Promise<TurnFileRef[] | null> => {
    const refs = await Promise.all(chips.map(({ id, file }) => nameOf(id, file).catch(() => null)));
    return refs.every((ref): ref is TurnFileRef => ref !== null) ? refs : null;
  }, [nameOf]);

  /** 发送前:等还在放的放完。全都成了 → true。 */
  const waitForUploads = useCallback(async (): Promise<boolean> => {
    const results = await Promise.all([...uploads.current.values()].map((upload) => upload.settled));
    return results.every(Boolean);
  }, []);

  /** 有没有还没放成的(放着的、失败的)—— 没有就不必等,直接发。 */
  const unsettled = useCallback(() => [...uploads.current.values()].some((upload) => upload.status !== 'done'), []);

  /** 这几枚 chip 放好的引用,按给的顺序(这一轮带走的就是它们)。 */
  const files = useCallback(
    (chipIds: readonly string[]): TurnFileRef[] => chipIds.flatMap((id) => {
      const ref = uploads.current.get(id)?.ref;
      return ref ? [ref] : [];
    }),
    []
  );

  /** 这一枚发出去了 / 不要了:不再管(还在放就取消)。 */
  const forget = useCallback((chipId: string) => {
    uploads.current.get(chipId)?.controller.abort();
    uploads.current.delete(chipId);
    named.current.delete(chipId);
  }, []);

  /** 这枚 chip 是不是这里在管(放着、放好、失败)。 */
  const has = useCallback((chipId: string) => uploads.current.has(chipId), []);

  /** 发出去了:账清空(文件留在私聊文件夹里,这一轮的引用指着它们);私聊下次再问。 */
  const clear = useCallback(() => {
    for (const upload of uploads.current.values()) upload.controller.abort();
    uploads.current.clear();
    named.current.clear();
    target.current = null;
  }, []);

  return useMemo(
    () => ({ add, retry, keepOnly, prepare, waitForUploads, unsettled, files, has, forget, clear }),
    [add, retry, keepOnly, prepare, waitForUploads, unsettled, files, has, forget, clear]
  );
}
