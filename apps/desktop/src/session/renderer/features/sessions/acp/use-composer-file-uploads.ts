/**
 * 输入框里文件 / 文件夹附件的那一排 chip(#5269、#6264;product spec):
 * **贴上来就开始传**,进度写在 chip 上;× 掉 = 取消并清掉已传的部分;失败在 chip 上说原因、能重试;
 * 发送时还没传完就等(`waitForUploads`),有一件没成就不发。
 * 本机会话与别的机器上的会话同一套;差别只在字节传到哪台机器(`rpc.sessionCreate.*` 按任务选线)。
 */
import type { ComposerAttachment } from '@gugu/session-ui/react/components';
import { MAX_ATTACHMENT_BYTES } from '@gugu/session-core/session-record/contract';
import { useCallback, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { formatBytes } from '@renderer/utils/formatBytes';
import { log } from '@renderer/utils/logger';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';
import {
  AttachmentUploadCancelled,
  AttachmentUploadFailure,
  sourceSize,
  uploadComposerAttachment,
  type AttachmentUploadRpc,
  type CommittedAttachment,
  type UploadSource,
} from './composer-file-upload';

type Translate = (key: SessionMessageLookupKey, values?: Record<string, string | number>) => string;

type Upload = { source: UploadSource; controller: AbortController; settled: Promise<boolean>; status: 'running' | 'done' | 'failed' };

export function progressMeta(sent: number, total: number): string {
  const percent = total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 100;
  return `${formatBytes(sent)} / ${formatBytes(total)} · ${percent}%`;
}

/** 失败在 chip 上怎么说。`device` = 会话所在那台机器的名字(本机会话为 null)。 */
export function failureMeta(
  failure: AttachmentUploadFailure,
  device: string | null,
  translate: Translate
): Pick<ComposerAttachment, 'meta' | 'retryable'> {
  if (failure.reason === 'too-large') {
    return { meta: translate('composer.attachmentTooLarge', { limit: formatBytes(MAX_ATTACHMENT_BYTES) }), retryable: false };
  }
  if (failure.reason === 'server-too-old' && device) {
    return { meta: translate('composer.attachmentServerTooOld', { device }), retryable: true };
  }
  return {
    meta: device ? translate('composer.attachmentFailedOn', { device }) : translate('composer.attachmentUploadFailed'),
    retryable: true,
  };
}

export function useComposerFileUploads(args: {
  /** 附件归哪个任务(新建会话页:预留的那个 id,取时才定)。 */
  sessionId: () => string;
  /** 会话所在那台机器的名字;本机会话 null。 */
  deviceLabel: () => string | null;
  setAttachments: Dispatch<SetStateAction<ComposerAttachment[]>>;
  /** 传完的一件交回去(任务内输入框记 chip id → 路径,新建会话页记整条待登记的记录)。 */
  onUploaded: (chipId: string, committed: CommittedAttachment) => void;
  translate: Translate;
  /** false = 只落盘不登记(新建会话页:任务还没建出来)。 */
  record?: boolean;
  /** 测试注入;缺省走 `rpc.sessionCreate`(按任务所在的机器路由)。 */
  uploadRpc?: AttachmentUploadRpc;
}) {
  // 回调要稳定(输入框的 props 靠它们),参数每次渲染都新:取用时读最新的那份。
  const latest = useRef(args);
  latest.current = args;
  const uploads = useRef(new Map<string, Upload>());

  const patch = useCallback(
    (chipId: string, next: Partial<ComposerAttachment>) =>
      latest.current.setAttachments((prev) => prev.map((att) => (att.id === chipId ? { ...att, ...next } : att))),
    []
  );

  const start = useCallback(
    (chipId: string, source: UploadSource) => {
      const { sessionId, deviceLabel, onUploaded, translate, record, uploadRpc } = latest.current;
      const controller = new AbortController();
      const upload: Upload = { source, controller, settled: Promise.resolve(false), status: 'running' };
      const total = sourceSize(source);
      patch(chipId, { state: 'uploading', progress: 0, cancelable: true, retryable: undefined, meta: progressMeta(0, total) });
      const settled = uploadComposerAttachment({
        rpc: uploadRpc ?? (rpc.sessionCreate as unknown as AttachmentUploadRpc),
        sessionId: sessionId(),
        uploadId: crypto.randomUUID(),
        source,
        signal: controller.signal,
        ...(record === false ? { record: false } : {}),
        onProgress: (sent, all) => {
          if (!controller.signal.aborted) {
            patch(chipId, { progress: all > 0 ? Math.min(100, (sent / all) * 100) : 100, meta: progressMeta(sent, all) });
          }
        },
      }).then(
        (committed) => {
          if (controller.signal.aborted) return false;
          upload.status = 'done';
          onUploaded(chipId, { ...committed, mentionPath: committed.mentionPath.trim().replace(/\\/g, '/') });
          patch(chipId, { state: 'done', progress: undefined, cancelable: undefined, meta: formatBytes(total) });
          return true;
        },
        (error: unknown) => {
          upload.status = 'failed';
          if (controller.signal.aborted || error instanceof AttachmentUploadCancelled) return false;
          const failure = error instanceof AttachmentUploadFailure ? error : new AttachmentUploadFailure('failed', String(error));
          // 原文进日志;chip 上只有人话。
          log.warn('composer attachment upload failed', { name: source.name, reason: failure.reason, detail: failure.detail });
          patch(chipId, { state: 'error', progress: undefined, cancelable: undefined, ...failureMeta(failure, deviceLabel(), translate) });
          return false;
        }
      );
      upload.settled = settled;
      uploads.current.set(chipId, upload);
      return settled;
    },
    [patch]
  );

  /** 上一枚 chip 并立刻开始传。 */
  const add = useCallback(
    (chip: ComposerAttachment, source: UploadSource) => {
      latest.current.setAttachments((prev) => [...prev, { ...chip, state: 'uploading', progress: 0, cancelable: true }]);
      return start(chip.id, source);
    },
    [start]
  );

  const retry = useCallback(
    (chipId: string) => {
      const upload = uploads.current.get(chipId);
      if (upload) void start(chipId, upload.source);
    },
    [start]
  );

  /** 输入框报来的剩下那几枚:不在里面的、还在传的取消(传输那头清掉已传的部分)。 */
  const keepOnly = useCallback((ids: ReadonlySet<string>) => {
    for (const [chipId, upload] of uploads.current) {
      if (ids.has(chipId)) continue;
      upload.controller.abort();
      uploads.current.delete(chipId);
    }
  }, []);

  /** 发送前:等还在传的传完。全都成了 → true。 */
  const waitForUploads = useCallback(async (): Promise<boolean> => {
    const results = await Promise.all([...uploads.current.values()].map((upload) => upload.settled));
    return results.every(Boolean);
  }, []);

  const busy = useCallback(() => uploads.current.size > 0, []);

  /** 有没有还没传成的(传着的、传失败的)—— 没有就不必等,直接发。 */
  const unsettled = useCallback(() => [...uploads.current.values()].some((upload) => upload.status !== 'done'), []);

  /** 这里在管的那几枚 chip。 */
  const ids = useCallback(() => [...uploads.current.keys()], []);
  /** 换创建目标时按原始字节重新入列,不能把上一台机器上的上传路径带过去。 */
  const sources = useCallback(() => new Map([...uploads.current].map(([id, upload]) => [id, upload.source])), []);

  /** 这一枚发出去了 / 不要了:不再管(还在传就取消)。 */
  const forget = useCallback((chipId: string) => {
    uploads.current.get(chipId)?.controller.abort();
    uploads.current.delete(chipId);
  }, []);

  /** 这枚 chip 是不是这里在管(传着、传完、传失败)。 */
  const has = useCallback((chipId: string) => uploads.current.has(chipId), []);

  /** 发出去了:账清空(那台机器上的文件留着,消息里的路径指着它们)。 */
  const clear = useCallback(() => uploads.current.clear(), []);

  return useMemo(
    () => ({ add, retry, keepOnly, waitForUploads, busy, unsettled, has, ids, sources, forget, clear }),
    [add, retry, keepOnly, waitForUploads, busy, unsettled, has, ids, sources, forget, clear]
  );
}
