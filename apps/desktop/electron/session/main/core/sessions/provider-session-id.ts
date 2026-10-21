import { eq } from 'drizzle-orm'
import { db } from '@main/db/client'
import { sessions } from '@main/db/schema'

/**
 * 会话此刻绑定的 provider 原生 session id(resume 时沿用、开新 session 时换)。
 * #3641 群规「会话恢复即重达」拿它判断 agent 的上下文是不是换了一段新的。
 */
export async function providerSessionIdForSession(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ providerSessionId: sessions.providerSessionId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
  return row?.providerSessionId ?? null
}
