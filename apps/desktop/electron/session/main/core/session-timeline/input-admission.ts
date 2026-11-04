import { isDeepStrictEqual } from 'node:util';
import type { SessionpageSessionSendRequest } from '@gugu/session-core/session-record/contract';
import type { PromptAttachment } from '@gugu/session-core/acp/client';
import { readAcceptedMessage } from '../sessions/sendMessage';
import { runtimeForkInput } from '../sessions/session-life-forks';

export type InputAdmissionPayload = {
  conversationId: string;
  text: string;
  clientMessageId?: string;
  files?: SessionpageSessionSendRequest['files'];
  attachments?: PromptAttachment[];
  steerIfBusy?: true;
};

export function sameInput(a: InputAdmissionPayload, b: InputAdmissionPayload): boolean {
  return a.text.trim() === b.text.trim()
    && a.steerIfBusy === b.steerIfBusy
    && isDeepStrictEqual(a.files ?? [], b.files ?? [])
    && isDeepStrictEqual(a.attachments ?? [], b.attachments ?? []);
}

/** A lost ACK cannot undo custody. Check the original receipt before refusing a replay. */
export function priorInputAdmission(input: InputAdmissionPayload): 'accepted' | 'uncertain' | null {
  if (!input.clientMessageId) return null;
  const fork = runtimeForkInput(input.conversationId, input.clientMessageId);
  if (fork) return sameInput(input, { ...input, text: fork.message.text,
    files: fork.message.delivery?.files, attachments: fork.message.delivery?.attachments, steerIfBusy: fork.message.delivery?.steerIfBusy }) ? 'accepted' : 'uncertain';
  const receipt = readAcceptedMessage(input.clientMessageId);
  if (!receipt) return null;
  if (receipt.sessionId !== input.conversationId || receipt.sender !== 'user') return 'uncertain';
  const metadata = receipt.metadata ? JSON.parse(receipt.metadata) : null;
  if (metadata?.kind !== 'ordinary-message' && metadata?.kind !== 'session-direct') return 'uncertain';
  const original = metadata.sourceInput ?? { text: receipt.content, files: metadata.delivery?.files, attachments: metadata.delivery?.attachments };
  return sameInput(input, { ...input, ...original, steerIfBusy: metadata.delivery?.steerIfBusy }) ? 'accepted' : 'uncertain';
}
