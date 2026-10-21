import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';

/** Persist a native provider control endpoint for future provider-owned forks. */
export async function setSessionEndpoint(sessionId: string, endpoint: string): Promise<void> {
  const value = endpoint.trim();
  if (!value) throw new Error(`empty provider session endpoint for ${sessionId}`);
  const rows = await db
    .select({ config: sessions.config })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  const current = rows[0]?.config;
  if (!current) throw new Error(`session ${sessionId} has no config`);
  await db
    .update(sessions)
    .set({ config: { ...current, providerSessionEndpoint: value }, updatedAt: new Date().toISOString() })
    .where(eq(sessions.id, sessionId));
}
