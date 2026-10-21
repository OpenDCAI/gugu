import { describe, expect, it } from 'vitest';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { assistantDescendants, dayBucket, groupByDay, isAssistantSession, launchedByAssistant } from './assistant-lineage';

type Row = { summary: Pick<SessionpageSessionSummary, 'conversationId' | 'agent' | 'parentConversationId' | 'spawnedByConversationId'> };
const row = (id: string, agent: string | null, parent: string | null = null, spawner: string | null = null): Row => ({
  summary: { conversationId: id, agent: agent ? { userId: agent } : null, parentConversationId: parent, spawnedByConversationId: spawner },
});

describe('isAssistantSession', () => {
  it('按 agent 身份认,❌ 没有身份的会话、❌ 还不知道助理是谁时', () => {
    expect(isAssistantSession({ agent: { userId: 'asst' } }, 'asst')).toBe(true);
    expect(isAssistantSession({ agent: { userId: 'other' } }, 'asst')).toBe(false);
    expect(isAssistantSession({ agent: null }, 'asst')).toBe(false);
    expect(isAssistantSession({ agent: { userId: 'asst' } }, null)).toBe(false);
  });
});

describe('assistantDescendants', () => {
  it('沿父会话和「由谁派的」两条边找出全部后代,它自己的和不相干的不在内', () => {
    const listed = [
      row('grandkid', 'g', 'kid'),
      row('kid', 'k', 'mine'),
      row('spawned', 's', null, 'mine'),
      row('mine', 'asst'),
      row('stranger', 'x'),
      row('strangers-kid', 'y', 'stranger'),
    ];
    expect(assistantDescendants(listed, 'asst').map((item) => item.summary.conversationId).sort()).toEqual(['grandkid', 'kid', 'spawned']);
    expect(assistantDescendants(listed, null)).toEqual([]);
  });
});

describe('launchedByAssistant', () => {
  const parents: Record<string, string | null> = { kid: 'mine', grandkid: 'kid', loop1: 'loop2', loop2: 'loop1', mine: null };
  const parentOf = (id: string) => parents[id] ?? null;
  it('父会话链上有它的就是它派的;链上有环也会停', () => {
    expect(launchedByAssistant('grandkid', parentOf, (id) => id === 'mine')).toBe(true);
    expect(launchedByAssistant('mine', parentOf, (id) => id === 'mine')).toBe(false);
    expect(launchedByAssistant('loop1', parentOf, (id) => id === 'mine')).toBe(false);
  });
});

describe('dayBucket / groupByDay', () => {
  const now = new Date(2026, 9, 15, 10, 0);
  it('按本地日历日分今天 / 昨天 / 近 7 天 / 更早', () => {
    expect(dayBucket(new Date(2026, 9, 15, 0, 5).toISOString(), now)).toBe('today');
    expect(dayBucket(new Date(2026, 9, 14, 23, 59).toISOString(), now)).toBe('yesterday');
    expect(dayBucket(new Date(2026, 9, 9, 12, 0).toISOString(), now)).toBe('week');
    expect(dayBucket(new Date(2026, 9, 1).toISOString(), now)).toBe('earlier');
    expect(dayBucket(null, now)).toBe('earlier');
  });
  it('只出有内容的组,顺序固定', () => {
    const items = [new Date(2026, 9, 1).toISOString(), new Date(2026, 9, 15, 9).toISOString()];
    expect(groupByDay(items, (at) => at, now).map((group) => group.bucket)).toEqual(['today', 'earlier']);
  });
});
