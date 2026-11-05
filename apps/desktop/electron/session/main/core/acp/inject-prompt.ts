import type { PromptAttachment } from '@gugu/session-core/acp/client';
import { isHumanDmDelivery, readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { getAcpRuntimeClient } from './runtime-process/host';
import { withDeferredMessagesBeforeAdmission } from '../sessions/session-deferred-messages';
import { ok, toSerializedError, type Result, type SerializedError } from '@gugu/session-shared';

/** Host-only admission path: return before the provider turn completes. */
export async function injectEmdashPromptDetached(
  sessionId: string,
  text: string,
  opts?: { clientMessageId?: string; sentAt?: number; steerIfBusy?: boolean; coalesceKey?: string; deferredDispatch?: true; origin?: 'manual' | 'typed' | 'communication'; hiddenContext?: string; attachments?: PromptAttachment[]; files?: import('@gugu/session-core/acp/client').PromptInput['files'] },
): Promise<{ outcome: 'started' | 'queued' | 'declined' | 'missing'; completion: Promise<Result<void, SerializedError>>; turnId?: string }> {
  const client = await getAcpRuntimeClient();
  // Plain user text keeps its manual queue policy; only actual envelopes may be merged as deliveries.
  const result = await withDeferredMessagesBeforeAdmission(sessionId, text, prepared => client.promptDetached({
    sessionId,
    prompt: { text: prepared, ...(opts?.clientMessageId ? { clientMessageId: opts.clientMessageId } : {}), ...(opts?.files?.length ? { files: opts.files } : {}), ...(opts?.sentAt !== undefined ? { sentAt: opts.sentAt } : {}), ...(opts?.hiddenContext ? { hiddenContext: opts.hiddenContext } : {}), ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}), origin: opts?.origin ?? (isHumanDmDelivery(text) ? 'manual' : readDeliveryEnvelope(prepared) ? 'communication' : 'manual'), ...(opts?.coalesceKey ? { coalesceKey: opts.coalesceKey } : {}) },
    ...(opts?.steerIfBusy ? { steerIfBusy: true } : {}),
  // A replaceable queued prompt must not take ownership of unrelated App context.
  }), Boolean(opts?.deferredDispatch || opts?.coalesceKey));
  if (result.declined) return { outcome: result.missing ? 'missing' : 'declined', completion: Promise.resolve(ok(undefined)) };
  return {
    outcome: result.queued ? 'queued' : 'started',
    // Observe rejection when the RPC is created, even if admission's caller has not returned yet.
    // Its owner consumes the result; neither cancellation nor a real fault becomes an orphan rejection.
    completion: client.waitPromptDetached({ requestId: result.requestId }).then(
      () => ok(undefined), error => ({ success: false as const, error: toSerializedError(error) })),
    turnId: result.requestId,
  };
}
