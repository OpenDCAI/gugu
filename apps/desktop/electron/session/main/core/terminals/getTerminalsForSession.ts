import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { terminals } from '@main/db/schema';
import { type Terminal } from '@shared/core/terminals/terminals';
import { mapTerminalRowToTerminal } from './core';

export async function getTerminalsForSession(sessionId: string): Promise<Terminal[]> {
  const rows = await db.select().from(terminals).where(eq(terminals.sessionId, sessionId));
  return rows.map(mapTerminalRowToTerminal);
}
