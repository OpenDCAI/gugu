import type { PromptAttachment } from '@gugu/session-core/acp/client';
import { isHumanDmDelivery, readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { getAcpRuntimeClient } from './runtime-process/host';
import { withDeferredMessagesBeforeAdmission } from '../sessions/session-deferred-messages';

/** Host-only admission path: return before the provider turn completes. */
export async function injectEmdashPromptDetached(
  sessionId: string,
  text: string,
  opts?: { steerIfBusy?: boolean; coalesceKey?: string; deferredDispatch?: true; origin?: 'manual' | 'typed' | 'communication'; hiddenContext?: string; attachments?: PromptAttachment[] },
): Promise<{ outcome: 'started' | 'queued' | 'declined' | 'missing'; completion: Promise<void>; turnId?: string }> {
  const client = await getAcpRuntimeClient();
  // Plain user text keeps its manual queue policy; only actual envelopes may be merged as deliveries.
  const result = await withDeferredMessagesBeforeAdmission(sessionId, text, prepared => client.promptDetached({
    sessionId,
    prompt: { text: prepared, ...(opts?.hiddenContext ? { hiddenContext: opts.hiddenContext } : {}), ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}), origin: opts?.origin ?? (isHumanDmDelivery(text) ? 'manual' : readDeliveryEnvelope(prepared) ? 'communication' : 'manual'), ...(opts?.coalesceKey ? { coalesceKey: opts.coalesceKey } : {}) },
    ...(opts?.steerIfBusy ? { steerIfBusy: true } : {}),
  // A replaceable queued prompt must not take ownership of unrelated App context.
  }), Boolean(opts?.deferredDispatch || opts?.coalesceKey));
  if (result.declined) return { outcome: result.missing ? 'missing' : 'declined', completion: Promise.resolve() };
  return {
    outcome: result.queued ? 'queued' : 'started',
    completion: client.waitPromptDetached({ requestId: result.requestId }).then(() => undefined),
    turnId: result.requestId,
  };
}
