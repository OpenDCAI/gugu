import { splitAttachmentMentions } from '../core/markdown/attachment-mentions';

/** Reply headers show the human caption and file labels, never attachment transport paths. */
export function conversationQuoteText(text: string): string {
  const split = splitAttachmentMentions(text);
  return split.attachments.length ? [split.text, ...split.attachments.map(file => file.name)].filter(Boolean).join('\n') : text;
}
