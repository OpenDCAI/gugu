import type { AskSource, PendingRequest, QuestionAnswer, Settlement, SessionTimeline, SessionpageSessionRespondRequest, SessionpageSessionRespondResult } from '@gugu/session-core/session-record/contract';
import { questionAnswerError } from '@gugu/session-core/session-record';
import { readAgentQuestionRecords, rememberAgentQuestion, settleAgentQuestionRecord } from '../sessions/agent-question-store';
import { sessionEvents } from '../sessions/session-events';
import { readSessionRow, syncAsked, type SessionTimelineResult } from '../session-timeline/service';
import { log } from '@main/lib/logger';
import { ASK_SOURCE_SPEC, type AskSourceSpec } from './sources';
const fail = (code: string, message: string) => ({ ok: false as const, error: { code, message } });

export type AskResult = AskAnswer | 'withdrawn' | 'timeout' | 'unavailable';
export type AskAnswer = { optionId: string; by: string; answers?: readonly QuestionAnswer[]; digest?: string; enableIn?: string[] };
type AskEntry = {
  request: PendingRequest & { origin: NonNullable<PendingRequest['origin']> };
  /** Why this answer cannot be taken (it stays asked), or null. */
  refuse?: (answer: AskAnswer) => string | null;
  answered: (answer: AskAnswer) => void;
  withdraw: () => void;
  detach: () => void;
};
export const hostAsks = new Map<string, Map<string, AskEntry>>();
let hostAskLifecycle: Array<() => void> | null = null;

/** Explicit interruption or removal invalidates question cards, including detached ones. */
export function withdrawAll(conversationId?: string, source?: AskSource): void {
  if (conversationId && !source) for (const item of readAgentQuestionRecords(conversationId)) {
    if (item.state === 'pending') settleAgentQuestionRecord(conversationId, item.itemId, { state: 'cancelled', optionId: null, by: null });
  }
  for (const [id, requests] of hostAsks) if (!conversationId || id === conversationId) {
    for (const entry of [...requests.values()]) if (!source || entry.request.origin.source === source) entry.withdraw();
  }
}

/** The session waits on the person while a host ask is out (an approval wait). Imported when asked: the status writer pulls in the
 *  hook service and the window's notifications, which this service has no other use for. One promise ⇒ start lands before end. */
let statusWriter: Promise<typeof import('@main/core/agent-status/agent-status-writer')> | null = null;
function reportHostWait(conversationId: string, id: string, open: boolean, source: AskSource): void {
  statusWriter ??= import('@main/core/agent-status/agent-status-writer');
  void statusWriter
    .then(({ agentStatusWriter }) => agentStatusWriter.reportHostWait({ sessionId: conversationId, id, open, waitKind: ASK_SOURCE_SPEC[source].waitKind }))
    .catch((error: unknown) => log.warn('sessionTimeline: the host wait was not reported', { conversationId, error: String(error) }));
}

export function ask(
  conversationId: string,
  request: AskEntry['request'],
  options: { signal?: AbortSignal; timeoutMs?: number; refuse?: AskEntry['refuse'] }
): Promise<AskResult> {
  if (!readSessionRow(conversationId)) return Promise.resolve('unavailable');
  if (options.signal?.aborted) return Promise.resolve('withdrawn');
  if (request.origin.source === 'agent-question') rememberAgentQuestion(conversationId, request);
  hostAskLifecycle ??= [sessionEvents.on('session:archived', withdrawAll), sessionEvents.on('session:deleted', withdrawAll)];
  return new Promise((resolve) => {
    const asks = hostAsks.get(conversationId) ?? new Map<string, AskEntry>();
    hostAsks.set(conversationId, asks);
    const wait = `host-ask:${request.itemId}`;
    const aborted = (reason: 'withdrawn' | 'timeout' = 'withdrawn') => {
      if (request.origin.source === 'agent-question') settleAgentQuestionRecord(conversationId, request.itemId, { state: 'cancelled', optionId: null, by: null });
      end(reason);
    };
    const onAbort = () => aborted();
    const end = (answer: AskResult, publish = true) => {
      if (!asks.delete(request.itemId)) return;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (asks.size === 0) hostAsks.delete(conversationId);
      reportHostWait(conversationId, wait, false, request.origin.source);
      if (publish) syncAsked(conversationId);
      resolve(answer);
    };
    const spec: AskSourceSpec = ASK_SOURCE_SPEC[request.origin.source];
    const timeoutMs = options.timeoutMs ?? spec.timeoutMs;
    const timer = timeoutMs === undefined ? null : setTimeout(() => aborted('timeout'), timeoutMs);
    timer?.unref?.();
    asks.set(request.itemId, { request, ...(options.refuse ? { refuse: options.refuse } : {}), answered: end, withdraw: () => aborted(), detach: () => end('withdrawn', false) });
    reportHostWait(conversationId, wait, true, request.origin.source);
    syncAsked(conversationId);
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `respond` on a host's ask: refused (it stays asked), lost the race, or settled and handed to the host. */
export function respond(
  timeline: SessionTimeline,
  input: Extract<SessionpageSessionRespondRequest, { optionId: string }>,
  current: Settlement
): SessionTimelineResult<SessionpageSessionRespondResult> {
  const ask = hostAsks.get(input.conversationId)?.get(input.itemId);
  // Withdrawn (its clock ran out) or already answered: said as it is — 「已经不等了」 / 「已在某端回答」.
  if (!ask || current.state !== 'pending') return { ok: true, value: { accepted: false, settlement: current } };
  const answer: AskAnswer = {
    optionId: input.optionId,
    by: input.by,
    ...(input.digest ? { digest: input.digest } : {}),
    ...(input.enableIn ? { enableIn: [...input.enableIn] } : {}),
  };
  const refusal = ask.refuse?.(answer);
  if (refusal) return fail('host_ask_refused', refusal);
  const settled = timeline.settle({ itemId: input.itemId, optionId: input.optionId, by: input.by });
  if (!settled.ok) return { ok: true, value: { accepted: false, settlement: settled.existing } };
  ask.answered(answer);
  return { ok: true, value: { accepted: true, settlement: settled.settlement } };
}

export function respondQuestion(
  timeline: SessionTimeline,
  input: Exclude<SessionpageSessionRespondRequest, { optionId: string }>,
  current: Settlement,
): SessionTimelineResult<SessionpageSessionRespondResult> {
  const ask = hostAsks.get(input.conversationId)?.get(input.itemId);
  if (!ask || current.state !== 'pending') return { ok: true, value: { accepted: false, settlement: current } };
  if ('decline' in input) {
    try { settleAgentQuestionRecord(input.conversationId, input.itemId, { state: 'cancelled', optionId: null, by: input.by }); }
    catch (error) { return fail('persist_failed', String(error)); }
    timeline.cancelSettlement(input.itemId);
    ask.answered({ optionId: 'withdrawn', by: input.by });
    return { ok: true, value: { accepted: true, settlement: timeline.getSnapshot({ limit: 1 }).settlements.find(s => s.itemId === input.itemId)! } };
  }
  const invalid = questionAnswerError(current.questions ?? [], input.answers);
  if (invalid) return fail('answer_invalid', invalid);
  try { settleAgentQuestionRecord(input.conversationId, input.itemId, { state: 'resolved', optionId: JSON.stringify(input.answers), by: input.by }); }
  catch (error) { return fail('persist_failed', String(error)); }
  const settled = timeline.settle({ itemId: input.itemId, optionId: JSON.stringify(input.answers), by: input.by });
  if (!settled.ok) return { ok: true, value: { accepted: false, settlement: settled.existing } };
  ask.answered({ optionId: 'answered', answers: input.answers, by: input.by });
  return { ok: true, value: { accepted: true, settlement: settled.settlement } };
}

export function resetAsks(): void {
  for (const requests of [...hostAsks.values()]) for (const entry of [...requests.values()]) { if (entry.request.origin.source === 'agent-question') entry.detach(); else entry.withdraw(); }
  for (const stop of hostAskLifecycle ?? []) stop();
  hostAskLifecycle = null;
}
