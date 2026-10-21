import { eq, isNull } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions, terminals } from '@main/db/schema';
import type { Terminal } from '@shared/core/terminals/terminals';
import { mapTerminalRowToTerminal } from './core';

export async function getAllTerminals(): Promise<Terminal[]> {
  const rows = await db
    .select({ terminal: terminals })
    .from(terminals)
    .innerJoin(sessions, eq(terminals.sessionId, sessions.id))
    .where(isNull(sessions.archivedAt));
  return rows.map(({ terminal }) => mapTerminalRowToTerminal(terminal));
}
