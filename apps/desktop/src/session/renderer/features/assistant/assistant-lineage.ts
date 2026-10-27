// #7199 个人助理与它的子 agent(owner:「它不应该生活在任务区,任务 agent 只是它的一些子 agent」)。
// 它自己的会话 = 那条会话的 agent 就是它(按身份认,❌ 按名字);子 agent = 沿「父会话 / 由谁派的」这条边往下找到的全部后代。
// 这里只放纯判定(可单测):任务区藏起它自己那条、标出它派的;助理 App 的「任务」列它的子 agent。
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink';

export type ListedSession = { deviceId: string; summary: SessionpageSessionSummary; live: boolean };

export function isAssistantSession(summary: Pick<SessionpageSessionSummary, 'agent'>, assistantId: string | null | undefined): boolean {
  return !!assistantId && summary.agent?.userId === assistantId;
}

/** 它派出来的全部会话(子、孙……),它自己的不算;每条只出现一次。 */
export function assistantDescendants<T extends { summary: Pick<SessionpageSessionSummary, 'conversationId' | 'agent' | 'parentConversationId' | 'spawnedByConversationId'> }>(
  listed: readonly T[],
  assistantId: string | null | undefined
): T[] {
  if (!assistantId) return [];
  const seen = new Set(listed.filter((item) => isAssistantSession(item.summary, assistantId)).map((item) => item.summary.conversationId));
  const out: T[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of listed) {
      const id = item.summary.conversationId;
      if (seen.has(id)) continue;
      const parent = item.summary.parentConversationId ?? null;
      const spawner = item.summary.spawnedByConversationId ?? null;
      if ((parent && seen.has(parent)) || (spawner && seen.has(spawner))) {
        seen.add(id);
        out.push(item);
        grew = true;
      }
    }
  }
  return out;
}

/** Both shells include delegated descendants and tasks explicitly linked to this assistant chat. */
export function assistantTasks<T extends { summary: SessionpageSessionSummary }>(listed: readonly T[], assistantId: string, chatId: string | null): T[] {
  const descendants = new Set(assistantDescendants(listed, assistantId));
  return listed.filter((item) => item.summary.agent?.userId !== assistantId && (
    descendants.has(item) || (chatId !== null && item.summary.activitySourceLinks?.some((link) => parseConversationLink(link)?.chatId === chatId))
  ));
}

/** 这条会话是不是它派的(任务区那一行要标「助理发起」):父会话链上有它自己的会话。 */
export function launchedByAssistant(
  sessionId: string,
  parentOf: (id: string) => string | null,
  isAssistantOwn: (id: string) => boolean
): boolean {
  const visited = new Set<string>();
  let cursor = parentOf(sessionId);
  while (cursor && !visited.has(cursor)) {
    if (isAssistantOwn(cursor)) return true;
    visited.add(cursor);
    cursor = parentOf(cursor);
  }
  return false;
}

/** 任务列表的分组:今天 / 昨天 / 近 7 天 / 更早(按本地日历日)。 */
export type DayBucket = 'today' | 'yesterday' | 'week' | 'earlier';

export function dayBucket(iso: string | null, now: Date): DayBucket {
  if (!iso) return 'earlier';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'earlier';
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(at)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return 'week';
  return 'earlier';
}

export function groupByDay<T>(items: readonly T[], timeOf: (item: T) => string | null, now: Date): { bucket: DayBucket; items: T[] }[] {
  const order: DayBucket[] = ['today', 'yesterday', 'week', 'earlier'];
  const sorted = [...items].sort((a, b) => (timeOf(b) ?? '').localeCompare(timeOf(a) ?? ''));
  return order
    .map((bucket) => ({ bucket, items: sorted.filter((item) => dayBucket(timeOf(item), now) === bucket) }))
    .filter((group) => group.items.length > 0);
}
