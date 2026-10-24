import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { messages, sessions } from '@main/db/schema';

/** A checksum only: no messages or credentials enter logs or the migration audit. */
export function assistantConversationVersion(sessionId: string, database: Pick<typeof db, 'select'> = db): string {
  const [row] = database.select({ provider: sessions.providerSessionId, config: sessions.config, status: sessions.agentStatus })
    .from(sessions).where(eq(sessions.id, sessionId)).all();
  const input = database.select({ id: messages.id, content: messages.content, metadata: messages.metadata }).from(messages)
    .where(eq(messages.sessionId, sessionId)).all().sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify({ row, input })).digest('hex');
}
