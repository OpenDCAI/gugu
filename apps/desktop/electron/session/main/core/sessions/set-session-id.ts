import { err, ok, type BaseError, type Result } from '@gugu/session-shared';
import { and, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { assistantConversationVersion } from './assistant-context-version';

export type SetProviderSessionIdError = BaseError<'empty-session-id' | 'session-not-found'>;

/**
 * Writes the agent-facing session id and publishes the same fact to live renderers.
 *
 * Performs a single guarded UPDATE rather than a read-then-write: the affected-row
 * count tells us whether the conversation existed, so no existence pre-check is needed.
 * Returns an error when the id is empty or the conversation does not exist.
 */
export async function setProviderSessionId(
  sessionId: string,
  providerSessionId: string
): Promise<Result<void, SetProviderSessionIdError>> {
  const trimmed = providerSessionId.trim();
  if (!trimmed) return err({ type: 'empty-session-id' });

  const rows = await db
    .update(sessions)
    .set({ providerSessionId: trimmed, updatedAt: new Date().toISOString() })
    .where(eq(sessions.id, sessionId))
    .returning({
      projectId: sessions.projectId,
    });

  if (rows.length === 0) {
    return err({ type: 'session-not-found', message: sessionId });
  }

  const row = rows[0];
  events.emit(sessionChangedChannel, {
    sessionId,
    projectId: row.projectId,
    changes: { providerSessionId: trimmed },
  });

  return ok();
}

/**
 * 把这一格清掉,并把同一件事告诉活着的渲染进程 —— {@link setSessionId} 的另一半。
 *
 * ⚠️ 它存在的理由与 setSessionId 逐字相同:`sessions.provider_session_id` **只能有一个写口**,
 * 而写口的定义里就包含「写完要说一声」。少了这一半,首启失败退账那次(hydrateSession)
 * 就只能直接 `db.update`,于是渲染端会一直拿着一个**其实已经作废**的 id ——
 * 而「记录里没有」与「渲染端以为有」在界面上完全同形。
 *
 * ## `expectedSessionId`:只退**自己那笔**
 *
 * 退账是补偿动作,而它与别的写口是**并发**的:hydrate 认领之后 pty 要起好几秒,`fork-capture`
 * 每 5 秒扫一趟,完全可能在这个窗口里把一个**真的** provider 会话 id 绑上来。这时候无条件清空
 * 就把一条真接得上的会话抹成「没有」,下次打开从零开始 —— 用户什么都没做,历史却没了。
 * ⇒ 带上「我当初认领的是哪个 id」,`WHERE session_id = <它>` 才清。同一条纪律见
 * `markProviderSessionMissing`(它也是拿着期望值去写的)。
 *
 * 没清到不算错(会话被删了,或者这一格已经被别人改成别的值):那说明这笔账**不该**由我退。
 * 返回值说清到底动没动,调用方要记账时用得上。
 */
export async function clearProviderSessionId(
  sessionId: string,
  expectedProviderSessionId: string
): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set({ providerSessionId: null, updatedAt: new Date().toISOString() })
    .where(
      and(eq(sessions.id, sessionId), eq(sessions.providerSessionId, expectedProviderSessionId))
    )
    .returning({
      projectId: sessions.projectId,
    });

  const row = rows[0];
  if (!row) return false;
  events.emit(sessionChangedChannel, {
    sessionId,
    projectId: row.projectId,
    // `null` 而不是 `undefined` —— 理由见 sessionChangedChannel 那侧的抬头(JSON 会吃掉 undefined)。
    changes: { providerSessionId: null },
  });
  return true;
}

/** Atomically publish a verified maintenance branch, retaining the previous native id for rollback. */
export function promoteAssistantContextCandidate(input: {
  sessionId: string; token: string; previousProviderSessionId: string; candidateProviderSessionId: string;
  expectedVersion: string;
}, now = Date.now()): boolean {
  if (!input.candidateProviderSessionId.trim() || input.candidateProviderSessionId === input.previousProviderSessionId) return false;
  const promoted = db.transaction(tx => {
    if (assistantConversationVersion(input.sessionId, tx) !== input.expectedVersion) return null;
    const [row] = tx.select().from(sessions).where(eq(sessions.id, input.sessionId)).all();
    if (!row || row.config?.type !== 'acp') return null;
    const lease = row.config.assistantContextMigration;
    if (row.providerSessionId !== input.previousProviderSessionId || lease?.state !== 'running'
      || lease.token !== input.token || lease.candidateProviderSessionId !== input.candidateProviderSessionId
      || lease.expiresAt <= now || row.agentStatus === 'working'
      || row.config?.messageOutbox?.length) return null;
    tx.update(sessions).set({ providerSessionId: input.candidateProviderSessionId,
      updatedAt: new Date(now).toISOString(), config: { ...row.config, contextUsage: undefined,
        assistantContextMigration: { ...lease, state: 'completed', candidateProviderSessionId: input.candidateProviderSessionId,
          finishedAt: new Date(now).toISOString() } },
    }).where(and(eq(sessions.id, input.sessionId), eq(sessions.providerSessionId, input.previousProviderSessionId))).run();
    return row;
  });
  if (!promoted) return false;
  events.emit(sessionChangedChannel, { sessionId: input.sessionId, projectId: promoted.projectId,
    changes: { providerSessionId: input.candidateProviderSessionId } });
  return true;
}
