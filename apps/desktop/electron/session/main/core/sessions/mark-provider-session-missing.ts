import { and, eq } from 'drizzle-orm'
import { db } from '@main/db/client'
import { sessions } from '@main/db/schema'
import { events } from '@main/lib/events'
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents'

export async function markProviderSessionMissing(
  sessionId: string,
  expectedProviderSessionId: string
): Promise<boolean> {
  const [row] = await db
    .select({
      projectId: sessions.projectId,
      providerSessionId: sessions.providerSessionId,
      config: sessions.config
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
  if (!row) throw new Error(`Session not found: ${sessionId}`)
  if (!row.config) throw new Error(`Session has no config: ${sessionId}`)
  if (row.providerSessionId !== expectedProviderSessionId) return false

  const updated = await db
    .update(sessions)
    .set({
      config: { ...row.config, providerSessionState: 'missing' },
      updatedAt: new Date().toISOString()
    })
    .where(
      and(eq(sessions.id, sessionId), eq(sessions.providerSessionId, expectedProviderSessionId))
    )
    .returning({ id: sessions.id })
  if (updated.length === 0) return false

  events.emit(sessionChangedChannel, {
    sessionId,
    projectId: row.projectId,
    changes: { providerSessionState: 'missing' }
  })
  return true
}

/**
 * {@link markProviderSessionMissing} 的另一半:这条会话刚起来了(用的正是 `providerSessionId` 这一条),
 * 「引擎那边没有它」就不再成立 —— 去掉那个标记,活着的渲染端照着画,❌ 一条正在跑的会话顶着「已经没有这条会话了」。
 * 最常见的是一轮都没跑完过的会话被同一个引擎新开了(#7223)。只认刚写下的那个 id:库里已经换了就不动。
 */
export async function clearProviderSessionMissing(
  sessionId: string,
  providerSessionId: string
): Promise<boolean> {
  const [row] = await db
    .select({
      projectId: sessions.projectId,
      providerSessionId: sessions.providerSessionId,
      config: sessions.config
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
  if (!row?.config || row.config.providerSessionState !== 'missing') return false
  if (row.providerSessionId !== providerSessionId) return false

  // 整键去掉,与 restartSession 同一个写法。
  const { providerSessionState: _cleared, ...rest } = row.config
  const updated = await db
    .update(sessions)
    .set({ config: rest, updatedAt: new Date().toISOString() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.providerSessionId, providerSessionId)))
    .returning({ id: sessions.id })
  if (updated.length === 0) return false

  events.emit(sessionChangedChannel, {
    sessionId,
    projectId: row.projectId,
    // `null` 而不是 undefined:网页宿主那条传输走 JSON,值为 undefined 的键会整个丢掉(见 sessionChangedChannel)。
    changes: { providerSessionState: null }
  })
  return true
}
