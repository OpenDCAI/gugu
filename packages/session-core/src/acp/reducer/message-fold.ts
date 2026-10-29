import { foldEntityContent, messageContentText, patchEntityMeta } from '../models/entity-content';
import type { TranscriptMessage, TranscriptThinking } from '../models/turns';
import type { NormalizedEvent } from './normalized-event';

/** One content fold owns both canonical blocks and their text projection. */
export function foldMessageContent<T extends TranscriptMessage | TranscriptThinking>(
  item: T,
  event: Extract<NormalizedEvent, { kind: 'message' | 'thinking' }>,
): T {
  const previous = item.content ?? (item.text ? [{ type: 'text', text: item.text }] : []);
  const incoming = event.contentMode === 'replace' ? event.content : event.content ?? [{ type: 'text', text: event.text }];
  const content = foldEntityContent(previous, incoming, event.contentMode ?? 'append');
  const next = { ...item, content, text: messageContentText(content) };
  const meta = patchEntityMeta(item._meta, event._meta);
  if (meta === undefined) delete next._meta;
  else next._meta = meta;
  return next;
}
