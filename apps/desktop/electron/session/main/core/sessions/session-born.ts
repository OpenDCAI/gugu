import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer';
import { sessionEvents } from '@main/core/sessions/session-events';
import { mapSessionRowToSession } from '@main/core/sessions/utils';
import type { SessionRow } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { Session } from '@shared/core/sessions/sessions';

/**
 * 一行会话落库之后的出生,四条建行的路(新建、派生、两种外部分叉)同一份:状态写入者记下出生 —— 排在这条
 * 会话的任何事件之前(spec agent-status-writer)—— 再告诉宿主内的订阅方有了一条新会话。
 * 渲染层那一声(`sessionCreatedChannel`)各路自己发:派生要等首次启动之后。
 */
export function sessionBorn(row: SessionRow, by: string): Session {
  const session = mapSessionRowToSession(row);
  void agentStatusWriter.birth(session).catch((error: unknown) => {
    log.error(`${by}: the status writer could not record the birth`, { sessionId: session.id, error: String(error) });
  });
  sessionEvents._emit('session:created', session);
  return session;
}
