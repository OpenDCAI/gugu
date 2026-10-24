import type { AcpSendPromptError, AcpTranscriptParser, NormalizedEvent, QueuedPrompt } from '@gugu/session-core/acp';
import { acpErr } from '@gugu/session-core/acp';
import { ok, type Result } from '@gugu/session-shared';
import type { SessionPromptResult } from './cell-deps';

export type PromptResult = Result<SessionPromptResult, AcpSendPromptError>;

/** A dispatch is admitted independently of the foreground cycle that owns its native echo. */
export type PromptRequest = {
  messageId: string;
  prompt: QueuedPrompt;
  steered: boolean;
  cycle: Promise<PromptResult> | null;
  submitted: Extract<NormalizedEvent, { kind: 'message' }>;
  accepted: boolean;
  dispatched: boolean;
  completion: ReturnType<typeof Promise.withResolvers<PromptResult>>;
};

export function reconcilePromptEcho(requests: Map<string, PromptRequest>, transcript: AcpTranscriptParser,
  event: Extract<NormalizedEvent, { kind: 'message' }>): typeof event {
  const request = [...requests.values()].find(request => request.accepted && request.messageId === event.messageId);
  if (!request || !event.messageId) return event;
  if (request.submitted.messageId !== event.messageId) transcript.removeSubmittedMessage(request.submitted.messageId!);
  return { ...event, ...request.submitted, messageId: event.messageId };
}

export function acceptPromptMessage(request: PromptRequest, messageId: string, transcript: AcpTranscriptParser,
  push: (event: NormalizedEvent) => void): void {
  request.messageId = messageId;
  request.accepted = true;
  const inserted = { ...request.submitted, messageId, contentMode: 'replace' as const };
  if (!transcript.hasEntity(inserted)) return;
  push(inserted);
}

export function settleAcceptedRequests(requests: Map<string, PromptRequest>, transcript: AcpTranscriptParser, missingEcho = false): void {
  for (const [id, request] of requests) {
    if (!request.accepted) continue;
    const owner = transcript.entityOwner({ ...request.submitted, messageId: request.messageId });
    const outcome = owner?.outcome;
    if (!outcome && (owner || !missingEcho)) continue;
    request.completion.resolve(!owner || outcome?.kind === 'error'
      ? acpErr.promptFailed({ name: 'ForegroundError', message: outcome?.kind === 'error'
        ? outcome.detail ?? outcome.reason ?? 'Foreground failed' : 'Accepted message was not echoed before idle' })
      : ok({ queued: false }));
    requests.delete(id);
  }
}
