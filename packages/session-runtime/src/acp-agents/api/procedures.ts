import { trimCursorPageForTransport, trimTurnsForTransport } from '@gugu/session-core/session-record';
import type { HistoryCursor } from '@gugu/session-core/acp/client';
import type {
  AcpAttachmentError,
  AcpCancelTurnError,
  AcpChangeQueuePromptOrderError,
  AcpDeleteQueuedPromptError,
  AcpEditQueuedPromptError,
  AcpExportRawLogError,
  AcpExportTranscriptError,
  AcpGetHistoryError,
  AcpQueuePromptError,
  AcpResolvePermissionError,
  AcpResumeSessionError,
  AcpSendPromptError,
  AcpSetModeOptionError,
  AcpSetModelOptionError,
  AcpSetPromptDraftError,
  AcpStartSessionError,
  AcpSteerQueuedPromptError,
  AcpStopBackgroundTaskError,
  AcpStopSessionError,
  AcpRuntimeStartInput,
  AttachmentMimeType,
  AttachmentRef,
  HistoryPage,
  PromptDraftUpdate,
  PromptInput,
  QueuedPromptEdit,
  ResumeResult,
} from '@gugu/session-core/acp';
import { ok, type Result } from '@gugu/session-shared';
import { randomUUID } from 'node:crypto';
import { blobSourceFromBytes, type WireFile } from '@gugu/session-wire';
import type { AcpRuntime } from '../runtime/runtime';
import type { LiveSettingApplyResult } from '../session/cell-deps';

export type StartSessionInput = AcpRuntimeStartInput;

export function createAcpProcedures(runtime: AcpRuntime) {
  const detachedPrompts = new Map<string, Promise<Result<{ queued: boolean }, AcpSendPromptError>>>();
  const errorMessage = (error: AcpSendPromptError): string => {
    if (error.message) return error.message;
    if ('cause' in error && error.cause?.message) return error.cause.message;
    return `ACP prompt failed (${error.type})`;
  };
  return {
    startSession(input: {
      input: StartSessionInput;
    }): Promise<Result<{ providerSessionId: string }, AcpStartSessionError>> {
      return runtime.startSession(input.input);
    },
    async resumeSession(input: {
      input: StartSessionInput & { providerSessionId: string };
    }): Promise<Result<ResumeResult, AcpResumeSessionError>> {
      const result = await runtime.resumeSession(input.input);
      return result.success ? ok(trimCursorPageForTransport(result.data)) : result;
    },
    stopSession(input: {
      sessionId: string;
    }): Promise<Result<void, AcpStopSessionError>> {
      return runtime.stopSession(input.sessionId);
    },
    sendPrompt(input: {
      sessionId: string;
      prompt: PromptInput;
      steerIfBusy?: boolean;
    }): Promise<Result<{ queued: boolean }, AcpSendPromptError>> {
      return runtime.sendPrompt(input.sessionId, input.prompt, input.steerIfBusy ? { steerIfBusy: true } : undefined);
    },
    async promptDetached(input: {
      sessionId: string;
      prompt: PromptInput;
      steerIfBusy?: boolean;
    }): Promise<{ requestId: string; queued: boolean; steered?: boolean; declined: boolean }> {
      const started = runtime.promptDetached(input.sessionId, input.prompt, input.steerIfBusy ? { steerIfBusy: true } : undefined);
      if (!started.success) throw new Error(started.error.message);
      const admission = await started.data.admission;
      if (!admission.success) {
        void started.data.completion.catch(() => undefined);
        // 会话此刻不收(原位回退进行中,#7308):调用方留着消息,等它收的那一刻再投。
        if (admission.error.type === 'session_busy') {
          return { requestId: '', queued: false, declined: true };
        }
        throw new Error(errorMessage(admission.error));
      }
      const requestId = randomUUID();
      // Attach a rejection consumer at storage time. The wait RPC is a separate wire call and may
      // arrive after the provider has already failed; leaving this promise bare creates an
      // unhandled-rejection window before waitPromptDetached can consume it.
      void started.data.completion.catch(() => undefined);
      detachedPrompts.set(requestId, started.data.completion);
      return {
        requestId,
        queued: admission.data.queued,
        ...(admission.data.steered ? { steered: true } : {}),
        declined: false,
      };
    },
    async waitPromptDetached(input: { requestId: string }): Promise<{ queued: boolean }> {
      const completion = detachedPrompts.get(input.requestId);
      if (!completion) throw new Error(`detached prompt ${input.requestId} was not found`);
      detachedPrompts.delete(input.requestId);
      const result = await completion;
      if (!result.success) throw new Error(errorMessage(result.error));
      return result.data;
    },
    async queuePrompt(input: {
      sessionId: string;
      prompt: PromptInput;
      startInput?: AcpRuntimeStartInput;
    }): Promise<Result<{ queued: boolean }, AcpQueuePromptError>> {
      return runtime.queuePrompt(input.sessionId, input.prompt, input.startInput);
    },
    editQueuedPrompt(input: {
      sessionId: string;
      id: string;
      input: PromptInput;
      queueEdit?: QueuedPromptEdit | null;
    }): Result<void, AcpEditQueuedPromptError> {
      return runtime.editQueuedPrompt(input.sessionId, input.id, input.input, input.queueEdit);
    },
    deleteQueuedPrompt(input: {
      sessionId: string;
      id: string;
    }): Result<void, AcpDeleteQueuedPromptError> {
      return runtime.deleteQueuedPrompt(input.sessionId, input.id);
    },
    changeQueuePromptOrder(input: {
      sessionId: string;
      ids: string[];
    }): Result<void, AcpChangeQueuePromptOrderError> {
      return runtime.changeQueuePromptOrder(input.sessionId, input.ids);
    },
    steerQueuedPrompt(input: {
      sessionId: string;
      id: string;
    }): Promise<Result<void, AcpSteerQueuedPromptError>> {
      return runtime.steerQueuedPrompt(input.sessionId, input.id);
    },
    cancelTurn(input: { sessionId: string }): Promise<Result<void, AcpCancelTurnError>> {
      return runtime.cancelTurn(input.sessionId);
    },
    finishHistoryRevert(input: { sessionId: string }): void { runtime.finishHistoryRevert(input.sessionId); },
    revertSession(input: { sessionId: string; anchor: string }) {
      return runtime.revertSession(input.sessionId, input.anchor);
    },
    stopBackgroundTask(input: {
      sessionId: string;
      taskId: string;
    }): Promise<Result<void, AcpStopBackgroundTaskError>> {
      return runtime.stopBackgroundTask(input.sessionId, input.taskId);
    },
    setPromptDraft(input: {
      sessionId: string;
      draft: PromptDraftUpdate;
    }): Result<void, AcpSetPromptDraftError> {
      return runtime.setPromptDraft(input.sessionId, input.draft);
    },
    adapterProvenance(input: {
      sessionId: string;
    }): { connectionKey: string; pid: number | null } | null {
      return runtime.adapterProvenance(input.sessionId);
    },
    announceSession(input: Parameters<AcpRuntime['announceSession']>[0]): { delivered: boolean } {
      return runtime.announceSession(input);
    },
    setModelOption(input: {
      sessionId: string;
      dimension: 'model' | 'effort';
      value: string;
    }): Promise<Result<LiveSettingApplyResult, AcpSetModelOptionError>> {
      return runtime.setModelOption(input.sessionId, input.dimension, input.value);
    },
    setModeOption(input: {
      sessionId: string;
      value: string;
    }): Promise<Result<LiveSettingApplyResult, AcpSetModeOptionError>> {
      return runtime.setModeOption(input.sessionId, input.value);
    },
    resolvePermission(input: {
      sessionId: string;
      requestId: string;
      optionId: string;
    }): Result<void, AcpResolvePermissionError> {
      return runtime.resolvePermission(input.sessionId, input.requestId, input.optionId);
    },
    exportACPTranscript(input: {
      sessionId: string;
    }): Result<string, AcpExportTranscriptError> {
      return runtime.exportParsedTranscript(input.sessionId);
    },
    exportRawAcpLog(input: { sessionId: string }): Result<string, AcpExportRawLogError> {
      return runtime.exportRawAcpLog(input.sessionId);
    },
    async uploadAttachment(
      input: {
        originalPath?: string;
      },
      file: WireFile
    ): Promise<Result<AttachmentRef, AcpAttachmentError>> {
      // 字节**恒**读进来 —— ❌ 不再「有原路径就不读」(#5269)。原路径只是来历:那件东西
      // 一旦被挪走或删掉,只记指向的记录当场作废,而消息里那张图要长期画得出来。
      return runtime.uploadAttachment({
        data: await file.bytes(),
        mimeType: file.mimeType as AttachmentMimeType,
        name: file.name,
        originalPath: input.originalPath,
      });
    },
    async downloadAttachment(input: {
      id: string;
    }): Promise<
      Result<{ meta: AttachmentRef; source: AsyncIterable<Uint8Array> }, AcpAttachmentError>
    > {
      const result = await runtime.downloadAttachment(input.id);
      if (!result.success) return result;
      return ok({
        meta: result.data.ref,
        source: blobSourceFromBytes(result.data.data),
      });
    },
    deleteAttachment(input: { id: string }): Promise<Result<void, AcpAttachmentError>> {
      return runtime.deleteAttachment(input.id);
    },
    getToolImage(input: { sessionId: string; itemId: string; index: number }) {
      return ok(runtime.getToolImage(input.sessionId, input.itemId, input.index));
    },
    getHistory(input: {
      sessionId: string;
      before?: number;
      limit: number;
      changedSince?: HistoryCursor;
    }): Result<HistoryPage, AcpGetHistoryError> {
      const result = runtime.getHistory(input.sessionId, input.before, input.limit, input.changedSince);
      if (!result.success) return result;
      // Delta cursors must not advance past omitted changes; only pages drop older turns.
      return ok(input.changedSince === undefined
        ? trimCursorPageForTransport(result.data)
        : { ...result.data, turns: trimTurnsForTransport(result.data.turns) });

    },
  };
}

export type AcpProcedures = ReturnType<typeof createAcpProcedures>;
