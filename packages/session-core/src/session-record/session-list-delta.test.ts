import { describe, expect, it } from 'vitest';
import type { SessionpageSessionSummary, SessionpageSessionsListResult } from './contract';
import { applySessionListEvent, sessionListDelta } from './session-list-delta';

const row = (id: string, title = id): SessionpageSessionSummary => ({
  conversationId: id, projectId: 'p', title, harness: 'codex', runtime: 'acp', agentStatus: null, lastInteractedAt: null, supported: true,
});
const listOf = (...sessions: SessionpageSessionSummary[]): SessionpageSessionsListResult => ({ projects: [{ id: 'p', name: 'repo', path: '/r' }], sessions });

describe('会话列表推增量(协议 8):宿主怎么算、客户端怎么合,同一对函数', () => {
  it('只给变了的行(整行)与没了的 id;什么都没变不推', () => {
    const before = listOf(row('a'), row('b'), row('c'));
    const after = listOf(row('a'), row('b', 'renamed'), row('d'));
    expect(sessionListDelta(before, after)).toEqual({ changed: [row('b', 'renamed'), row('d')], removed: ['c'] });
    expect(sessionListDelta(before, listOf(row('a'), row('b'), row('c')))).toBeNull();
  });

  it('项目表变了才带上', () => {
    const before = listOf(row('a'));
    const after = { ...listOf(row('a')), projects: [{ id: 'p', name: 'repo', path: '/r' }, { id: 'q', name: 'new', path: '/q' }] };
    expect(sessionListDelta(before, after)).toEqual({ changed: [], removed: [], projects: after.projects });
  });

  it('客户端把增量合回去,得到的就是宿主那一份(按 id 换、新的接在后面、没了的拿掉)', () => {
    const before = listOf(row('a'), row('b'), row('c'));
    const after = listOf(row('a'), row('b', 'renamed'), row('d'));
    const delta = sessionListDelta(before, after)!;
    expect(applySessionListEvent(before, { subscriptionId: 's', ...delta })).toEqual(after);
    expect(applySessionListEvent(null, { subscriptionId: 's', full: after })).toEqual(after);
  });

  it('整份之前来了增量:响亮报错,❌ 拿残缺的列表冒充整份', () => {
    expect(() => applySessionListEvent(null, { subscriptionId: 's', changed: [], removed: ['a'] }))
      .toThrow('session list subscription s: a change arrived before the full list');
  });
});
