import { eq } from 'drizzle-orm';
import { isDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { TranscriptMessage, TranscriptTurn } from '@gugu/session-core/acp';
import { db, type AppDb } from '@main/db/client';
import { kv } from '@main/db/schema';

type Activity = { text: string; at: string; turnSeq: number };
type ActivityDb = Pick<AppDb, 'select' | 'insert'>;
const keyFor = (sessionId: string) => `native-conversation-activity:${sessionId}`;

export function nativeConversationActivity(sessionId: string, source: ActivityDb = db): Activity | null {
  const row = source.select({ value: kv.value }).from(kv).where(eq(kv.key, keyFor(sessionId))).get();
  if (!row) return null;
  const value = JSON.parse(row.value) as Activity | null;
  if (value === null) return null;
  if (typeof value.text !== 'string' || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at)) || !Number.isInteger(value.turnSeq)) throw new Error(`Invalid native conversation activity: ${sessionId}`);
  return value;
}

/** A live committed turn, not replay time or a synthetic IM message, supplies the preview. */
export function noteNativeConversationActivity(sessionId: string, turn: TranscriptTurn, source: ActivityDb): boolean {
  let latest: Activity | null = null;
  for (const item of personalConversationMessages(turn)) {
    const at = item.at ?? (item.role === 'assistant' ? turn.endedAt : turn.startedAt);
    if (!item.text.trim() || item.text.trim() === '[NO_REPLY]' || at === undefined) continue;
    // File mentions are input instructions. Do not expose local paths in a list preview.
    const text = item.attachments?.length || /\[(?:Folder file|Image attached at local path:)/.test(item.text) || /@\[[^\]]+\]\(/.test(item.text)
      ? '' : item.text.trim().replace(/\s+/g, ' ').slice(0, 180);
    if (text) latest = { text, at: new Date(at).toISOString(), turnSeq: turn.seq };
  }
  if (!latest) return false;
  const before = nativeConversationActivity(sessionId, source);
  if (before && (before.at > latest.at || JSON.stringify(before) === JSON.stringify(latest))) return false;
  source.insert(kv).values({ key: keyFor(sessionId), value: JSON.stringify(latest), updatedAt: Date.now() })
    .onConflictDoUpdate({ target: kv.key, set: { value: JSON.stringify(latest), updatedAt: Date.now() } }).run();
  return true;
}

/** A steered owner exchange belongs to the owner even when a delivery opened its turn. */
export function personalConversationMessages(turn: TranscriptTurn): TranscriptMessage[] {
  const legacyPersonal = turn.trigger ? turn.trigger.kind === 'owner' : turn.initiator === 'user';
  let personal = legacyPersonal;
  const selected: TranscriptMessage[] = [];
  for (const item of turn.items) {
    if (item.kind !== 'message') continue;
    if (item.role === 'user') {
      const ownerInput = item._meta?.guguOwnerInput;
      personal = typeof ownerInput === 'boolean' ? ownerInput : legacyPersonal && !isDeliveryEnvelope(item.text);
    }
    if (personal || item.ownerNotification) selected.push(item);
  }
  return selected;
}

export function truncateNativeConversationActivity(sessionId: string, fromSeq: number, source: ActivityDb, removed: ReadonlySet<number> = new Set()): boolean {
  const current = nativeConversationActivity(sessionId, source);
  if (!current || (current.turnSeq < fromSeq && !removed.has(current.turnSeq))) return false;
  source.insert(kv).values({ key: keyFor(sessionId), value: 'null', updatedAt: Date.now() })
    .onConflictDoUpdate({ target: kv.key, set: { value: 'null', updatedAt: Date.now() } }).run();
  return true;
}
