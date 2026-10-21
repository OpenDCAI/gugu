import type {
  SessionpageSessionsEvent,
  SessionpageSessionsListResult,
} from './contract';

/**
 * 会话列表推送只有一种推法(协议 8):订上那一刻一份整的,之后只推变了的行与没了的会话 —— 一台 381 条会话的机器
 * 一次状态变化从推整份(约 295 KB)变成推一行(约 1 KB)。宿主怎么算、客户端怎么合,都只看这两个函数。
 */

/** 上一份 → 这一份:变了(或新出现)的行整行给出,没了的给 id;项目表变了才带。什么都没变 = null(不推)。 */
export function sessionListDelta(
  previous: SessionpageSessionsListResult,
  next: SessionpageSessionsListResult,
): { changed: SessionpageSessionsListResult['sessions']; removed: string[]; projects?: SessionpageSessionsListResult['projects'] } | null {
  const before = new Map(previous.sessions.map((session) => [session.conversationId, JSON.stringify(session)]));
  const changed = next.sessions.filter((session) => before.get(session.conversationId) !== JSON.stringify(session));
  const present = new Set(next.sessions.map((session) => session.conversationId));
  const removed = previous.sessions.filter((session) => !present.has(session.conversationId)).map((session) => session.conversationId);
  const projectsChanged = JSON.stringify(previous.projects) !== JSON.stringify(next.projects);
  if (!changed.length && !removed.length && !projectsChanged) return null;
  return { changed, removed, ...(projectsChanged ? { projects: next.projects } : {}) };
}

/**
 * 把一帧推送合到手上那份上。整份就是它;增量按 conversationId 合:变了的原位换掉、新的接在后面、没了的拿掉。
 * 增量帧之前还没有整份 = 订阅的约定被破坏了,响亮报错(❌ 拿一份残缺的列表冒充整份)。
 */
export function applySessionListEvent(
  current: SessionpageSessionsListResult | null,
  event: SessionpageSessionsEvent,
): SessionpageSessionsListResult {
  if ('full' in event) return event.full;
  if (!current) throw new Error(`session list subscription ${event.subscriptionId}: a change arrived before the full list`);
  const changed = new Map(event.changed.map((session) => [session.conversationId, session]));
  const removed = new Set(event.removed);
  const sessions = current.sessions
    .filter((session) => !removed.has(session.conversationId))
    .map((session) => changed.get(session.conversationId) ?? session);
  const known = new Set(sessions.map((session) => session.conversationId));
  for (const session of event.changed) if (!known.has(session.conversationId)) sessions.push(session);
  return { projects: event.projects ?? current.projects, sessions };
}
