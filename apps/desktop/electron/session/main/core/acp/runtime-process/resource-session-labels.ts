import { inArray } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { taskName } from '../../sessions/task-name';

/** Only active runtime IDs are queried; do not load the entire session history on every sample. */
export async function resourceSessionLabels(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db.select({ id: sessions.id, config: sessions.config }).from(sessions).where(inArray(sessions.id, ids));
  return new Map(rows.map(row => [row.id, taskName(row)]));
}
