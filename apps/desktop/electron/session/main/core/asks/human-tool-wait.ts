import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { log } from '@main/lib/logger';
import {
  readHumanToolRecords, reportHumanToolDelivery, saveHumanToolRecord, prepareHumanToolResult,
  type HumanToolKind, type HumanToolRecord,
} from './human-tool-results';

export type HumanToolPending = {
  state: 'pending'; request_id: string; reason: 'interrupted_for_message'; next: string;
};
type Operation = {
  sessionId: string;
  waiting?: string;
  yielded: boolean;
  steered: boolean;
  settled: boolean;
  controller: AbortController;
  record: HumanToolRecord;
  release: () => void;
};
const context = new AsyncLocalStorage<Operation>();
const active = new Set<Operation>();

export const humanToolPending = (requestId: string): HumanToolPending => ({
  state: 'pending', request_id: requestId, reason: 'interrupted_for_message',
  next: 'The original request is still waiting for the person. Pending is not approval. Do not repeat the request or poll; handle the new message. The actual result will arrive as gugu_human_tool_result in this same session.',
});

/** Only the runtime's real promptSteered event may call this. Queued input is deliberately absent. */
export function yieldHumanToolWaits(sessionId: string): void {
  for (const operation of active) if (operation.sessionId === sessionId && !operation.settled) {
    operation.steered = true;
    if (operation.waiting) operation.release();
  }
}

/** ask() owns the human deadline/settlement. This registration owns only its tool caller's wait. */
export function registerHumanToolAsk(sessionId: string, requestId: string): () => void {
  const operation = context.getStore();
  if (!operation || operation.settled || operation.sessionId !== sessionId) return () => undefined;
  operation.waiting = requestId;
  if (!operation.yielded) operation.record.requestId = requestId;
  // Let the initial snapshot publish (and any immediate answer settle) before releasing.
  if (operation.steered) queueMicrotask(operation.release);
  return () => { if (operation.waiting === requestId) operation.waiting = undefined; };
}

/** Explicit stop/cancel remains cancellation; yielding never invokes this. */
export function stopHumanToolWaits(sessionId: string): void {
  for (const operation of active) if (operation.sessionId === sessionId) {
    operation.record.paused = true;
    try { if (operation.yielded) saveHumanToolRecord(operation.record); }
    catch (error) { log.error('Human tool stop could not persist its pause', { sessionId, error: String(error) }); }
    finally { operation.controller.abort(); }
  }
}

/**
 * The operation continues under a host lifetime after a steer releases its MCP waiter. Only the
 * narrow, registered Ask interval can yield. Normal tools and normal synchronous answers keep their contract.
 */
export function runHumanTool<T>(sessionId: string, tool: HumanToolKind, signal: AbortSignal | undefined,
  perform: (signal: AbortSignal) => Promise<T>, pending: (requestId: string) => T): Promise<T> {
  const parent = context.getStore();
  // Internal steps belong to the complete tool operation, including work after its consent.
  if (parent?.sessionId === sessionId && !parent.settled) return perform(parent.controller.signal);
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const operation: Operation = {
      sessionId, yielded: false, steered: false, settled: false, controller,
      record: { id: randomUUID(), requestId: '', sessionId, tool, messageId: randomUUID(), state: 'waiting' },
      release: () => {
        if (!operation.waiting || operation.settled || operation.yielded || controller.signal.aborted) return;
        // Persist ownership before releasing the caller or detaching its abort signal.
        try { saveHumanToolRecord(operation.record); }
        catch (error) { log.error('Human tool could not detach durably', { sessionId, error: String(error) }); return; }
        operation.yielded = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(pending(operation.waiting));
      },
    };
    active.add(operation);
    const finish = (result: unknown, failed: boolean) => {
      operation.settled = true;
      active.delete(operation);
      signal?.removeEventListener('abort', onAbort);
      if (!operation.yielded) { if (failed) reject(result); else resolve(result as T); return; }
      try {
        operation.record = prepareHumanToolResult(operation.record, failed ? { error: String(result) } : result);
        saveHumanToolRecord(operation.record);
        if (!operation.record.paused) reportHumanToolDelivery(operation.record);
      } catch (error) { log.error('Human tool result persistence failed', { sessionId, error: String(error) }); }
    };
    try { void context.run(operation, () => perform(controller.signal)).then(result => finish(result, false), error => finish(error, true)); }
    catch (error) { finish(error, true); }
  });
}

/** Process-bound operations cannot be resurrected as approvals. Say ended, using the original result ID. */
export function restoreHumanToolResults(sessionId: string, projectId: string, resumed = false): void {
  for (const saved of readHumanToolRecords(sessionId)) {
    if ([...active].some(operation => operation.record.id === saved.id) || (saved.paused && !resumed)) continue;
    const record: HumanToolRecord = saved.state === 'waiting'
      ? { ...saved, state: 'finished', result: { state: 'ended', reason: 'The original host operation ended before a result was recorded. No approval or success is implied.' } }
      : saved;
    saveHumanToolRecord(record);
    reportHumanToolDelivery(record, projectId);
  }
}
