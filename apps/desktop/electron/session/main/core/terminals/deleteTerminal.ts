import { and, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { terminals } from '@main/db/schema';
import { resolveSession } from '../projects/utils';

export async function deleteTerminal({
  projectId,
  sessionId,
  terminalId,
}: {
  projectId: string;
  sessionId: string;
  terminalId: string;
}) {
  await db
    .delete(terminals)
    .where(
      and(
        eq(terminals.id, terminalId),
        eq(terminals.projectId, projectId),
        eq(terminals.sessionId, sessionId)
      )
    );

  const session = resolveSession(projectId, sessionId);
  await session?.terminals.killTerminal(terminalId);
}
