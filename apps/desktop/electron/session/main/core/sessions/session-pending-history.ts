import { sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { deliverySourceIds, matchesDeliveryIdentity } from '@gugu/core/local/agent/deliveryIdentity';

/** Explicit resend checks the whole stored input history, independently of the UI's transport/page budget.
 * Read user items only: tool output and assistant prose cannot acknowledge an input. No provider is started.
 */
export function storedPendingInputLookup(sessionId: string): (input: { id: string; text: string }) => Promise<string | null> {
  const cached = new Map<string, string | null>();
  return async input => {
    if (cached.has(input.id)) return cached.get(input.id)!;
    const firstSource = deliverySourceIds(input.text)[0];
    const messages = db.all<{ id: string; text: string; clientMessageId: string | null }>(sql`
      SELECT json_extract(item.value, '$.id') AS id, coalesce(json_extract(item.value, '$.text'), '') AS text,
        json_extract(item.value, '$._meta.guguClientMessageId') AS clientMessageId
      FROM session_turns AS turn, json_each(turn.data, '$.items') AS item
      WHERE turn.session_id = ${sessionId} AND json_extract(item.value, '$.kind') = 'message'
        AND json_extract(item.value, '$.role') = 'user' AND json_type(item.value, '$.id') = 'text'
        AND (json_extract(item.value, '$._meta.guguClientMessageId') = ${input.id}
          OR json_extract(item.value, '$.id') = ${input.id}
          OR (${input.id.length >= 16 ? 1 : 0} AND instr(json_extract(item.value, '$.id'), ${input.id}) > 0)
          OR (${firstSource ?? null} IS NOT NULL AND instr(json_extract(item.value, '$.text'), ${firstSource ?? ''}) > 0))
    `);
    const echo = messages.find(message => matchesDeliveryIdentity(input, message))?.id ?? null;
    cached.set(input.id, echo);
    return echo;
  };
}
