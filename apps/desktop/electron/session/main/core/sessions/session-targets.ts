import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { terminals } from '@main/db/schema';

/** 这条会话名下的终端。会话自己就是另一个叶子(pty id 的叶子 = 会话 id)。 */
export async function getSessionLeafIds(
  sessionId: string
): Promise<{ terminalIds: string[] }> {
  const terminalRows = await db
    .select({ id: terminals.id })
    .from(terminals)
    .where(eq(terminals.sessionId, sessionId));
  return { terminalIds: terminalRows.map((row) => row.id) };
}
