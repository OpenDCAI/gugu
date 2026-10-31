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

export function acceptPromptMessage(request: PromptRequest, messageId: string, transcript: AcpTranscriptParser,
  push: (event: NormalizedEvent) => void, providerId: string): void {
  const inserted = { ...request.submitted, messageId, contentMode: 'replace' as const };
  if (!transcript.hasEntity(inserted)) throw new Error(`ACP provider '${providerId}' returned an accepted receipt before its user echo (${messageId})`);
  request.messageId = messageId;
  request.accepted = true;
  if (request.submitted.messageId !== messageId) transcript.removeSubmittedMessage(request.submitted.messageId!);
  push(inserted);
}

export function settleAcceptedRequests(requests: Map<string, PromptRequest>, transcript: AcpTranscriptParser): void {
  for (const [id, request] of requests) {
    if (!request.accepted) continue;
    const owner = transcript.entityOwner({ ...request.submitted, messageId: request.messageId });
    const outcome = owner?.outcome;
    if (!outcome) continue;
    request.completion.resolve(outcome.kind === 'error'
      ? acpErr.promptFailed({ name: 'ForegroundError', message: outcome.detail ?? outcome.reason ?? 'Foreground failed' })
      : ok({ queued: false }));
    requests.delete(id);
  }
}
