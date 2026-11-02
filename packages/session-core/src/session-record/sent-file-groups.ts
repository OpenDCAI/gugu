import type { TranscriptTurn, TranscriptItem } from '../acp/models/turns/turn';
import { messageSendTargetOf, replyItems } from './reply-process';
import { sentAttachmentOf, type SentAttachment } from './sent-attachment';

/** Adjacent successful sends only: a failed call, another destination or any other output breaks the group. */
export function sentFileGroups(turn: TranscriptTurn) {
  const groups: { first: TranscriptItem; last: TranscriptItem; attachments: SentAttachment[]; to: ReturnType<typeof messageSendTargetOf> }[] = [];
  const seen = new Set<string>();
  let previous: (typeof groups)[number] | undefined;
  for (const item of replyItems(turn)) {
    const attachment = sentAttachmentOf(item);
    if (!attachment) { previous = undefined; continue; }
    if (seen.has(attachment.messageId)) continue;
    seen.add(attachment.messageId);
    const to = messageSendTargetOf(item, turn);
    const destination = (target: typeof to) => target && [target.conversationId ?? target.chatId, target.threadRootId, target.whisper];
    if (previous && to && JSON.stringify(destination(previous.to)) === JSON.stringify(destination(to))) {
      previous.attachments.push(attachment);
      previous.last = item;
    } else {
      previous = { first: item, last: item, attachments: [attachment], to };
      groups.push(previous);
    }
  }
  return groups;
}
