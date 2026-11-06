import type { TranscriptMessage, TranscriptTurn } from '@gugu/session-core/acp';
import { personalConversationMessages } from '@gugu/session-core/session-record/personal-conversation';
import { nativeInputPublication, queueNativePublication, readPublicationValue, writePublicationValue, type NativePublication, type NativePublicationContext, type PublicationDb } from './native-publication-journal';

type TurnJournal = { context: NativePublicationContext | null; messages: Record<string, { id: string; at: string; context: NativePublicationContext }> };
const visible = (item: TranscriptMessage) => item.text.trim() !== '[NO_REPLY]'
  && Boolean(item.text.trim() || item.attachments?.length || item.files?.length || item.ownerNotification?.files?.length);

/**
 * A UUID is generated once at durable live admission. The immutable turn reference and reducer item
 * sequence only index aliases inside that saved record; neither is a publication ID or a timestamp.
 * Revision keeps the record when provider IDs change. A historical row has no live admission record.
 */
export function recordNativePublicationTurn(input: {
  sessionId: string; rowId: string; source: 'live' | 'revision' | 'backfill'; turn: TranscriptTurn;
  context: NativePublicationContext | null;
}, source: PublicationDb): TranscriptTurn {
  const key = `native-personal-turn:${JSON.stringify([input.sessionId, input.turn.referenceId ?? input.rowId])}`;
  const before = readPublicationValue<TurnJournal>(key, source);
  if (!before && input.source !== 'live') return input.turn;
  const journal: TurnJournal = before ?? { context: input.context, messages: {} };
  let context = journal.context;
  const personal = new Set(personalConversationMessages(input.turn));
  const items = input.turn.items.map(item => {
    if (item.kind !== 'message') return item;
    const slot = `${item.role}:${item.seq}`;
    const saved = journal.messages[slot];
    if (item.role === 'user') {
      const inputId = item._meta?.guguClientMessageId;
      const admitted = typeof inputId === 'string' ? nativeInputPublication(input.sessionId, inputId, source) : undefined;
      if (admitted && saved && admitted.id !== saved.id) throw new Error('Native transcript input admission changed');
      const owner = admitted ? { ownerUserId: admitted.ownerUserId, deviceId: admitted.deviceId, ...(admitted.agentUserId ? { agentUserId: admitted.agentUserId } : {}) } : undefined;
      context = personal.has(item) ? owner ?? saved?.context ?? journal.context : null;
      if (personal.has(item)) journal.context = context;
      if (admitted && owner && !saved) journal.messages[slot] = { id: admitted.id, at: admitted.occurredAt, context: owner };
    }
    if (!personal.has(item)) return item;
    let publication = journal.messages[slot];
    if (!publication && visible(item)) {
      const owner = item.ownerNotification ? input.context ?? context : context;
      const at = item.at ?? (item.role === 'assistant' ? input.turn.endedAt : input.turn.startedAt);
      if (owner && at !== undefined && Number.isFinite(at) && Number.isFinite(new Date(at).getTime())) {
        const entry: NativePublication = queueNativePublication(owner, input.sessionId, new Date(at).toISOString(), source);
        publication = journal.messages[slot] = { id: entry.id, at: entry.occurredAt, context: owner };
      }
    }
    return publication ? { ...item, _meta: { ...item._meta, guguPublicationId: publication.id, guguPublicationAt: publication.at } } : item;
  });
  writePublicationValue(key, journal, source);
  return { ...input.turn, items };
}
