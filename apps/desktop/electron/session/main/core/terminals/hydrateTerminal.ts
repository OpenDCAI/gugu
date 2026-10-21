import { and, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { terminals } from '@main/db/schema';
import { resolveSession } from '../projects/utils';
import { mapTerminalRowToTerminal } from './core';

export async function hydrateTerminal({
  projectId,
  sessionId,
  terminalId,
}: {
  projectId: string;
  sessionId: string;
  terminalId: string;
}): Promise<void> {
  const session = resolveSession(projectId, sessionId);
  if (!session) throw new Error('Session not mounted');

  const [row] = await db
    .select()
    .from(terminals)
    .where(
      and(
        eq(terminals.id, terminalId),
        eq(terminals.projectId, projectId),
        eq(terminals.sessionId, sessionId)
      )
    )
    .limit(1);
  if (!row) throw new Error('Terminal not found');

  await session.terminals.spawnTerminal(mapTerminalRowToTerminal(row));
}
