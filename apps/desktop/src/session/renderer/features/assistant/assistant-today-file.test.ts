import { describe, expect, it } from 'vitest';
import { dayOf, feedOrder, ideaGroups, parseTodayFile, type TodayBatch, type TodayIdea } from './assistant-today-file';

const batch = (over: Partial<TodayBatch> & Pick<TodayBatch, 'id'>): Record<string, unknown> => ({
  kind: 'morning',
  localDate: '2026-10-15',
  cards: [{ id: 'c1', title: '今天要紧的', markdown: '- 10 点开会' }],
  ...over,
});

describe('parseTodayFile', () => {
  it('读出简报和小组件;没写的可选格是 null,多出来的字段不管', () => {
    const parsed = parseTodayFile(
      JSON.stringify({
        version: 1,
        extra: true,
        batches: [batch({ id: 'b1', pushedAt: '2026-10-15T00:05:00Z', messageId: 'm1' }), batch({ id: 'b2', kind: 'diary' })],
        widgets: [{ id: 'w1', title: '比特币', markdown: '**$61k**', updatedAt: '2026-10-15T01:00:00Z' }],
      })
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.batches.map((b) => [b.id, b.kind, b.messageId, b.pushedAt])).toEqual([
      ['b1', 'morning', 'm1', '2026-10-15T00:05:00Z'],
      ['b2', 'diary', null, null],
    ]);
    expect(parsed.file.widgets[0]).toEqual({ id: 'w1', title: '比特币', markdown: '**$61k**', updatedAt: '2026-10-15T01:00:00Z', state: 'ready', schedule: null });
  });

  it('空的那份(助理刚建好)也是合法的', () => {
    const empty = { version: 1, batches: [], widgets: [], day: { state: 'none' }, ideas: { state: 'none' } };
    expect(parseTodayFile('{"version":1,"batches":[],"widgets":[]}')).toEqual({ ok: true, file: empty });
    expect(parseTodayFile('{"version":1}')).toEqual({ ok: true, file: empty });
  });

  it('写坏了就说哪一格坏了,❌ 跳过坏的装作没有', () => {
    const cases: [unknown, string][] = [
      ['not json', 'json'],
      [[], 'root'],
      [{ version: 2 }, 'version'],
      [{ version: 1, batches: {} }, 'root.batches'],
      [{ version: 1, batches: [batch({ id: 'b', kind: 'noon' as never })] }, 'batches[0].kind'],
      [{ version: 1, batches: [batch({ id: 'b', localDate: '10/15' })] }, 'batches[0].localDate'],
      [{ version: 1, batches: [batch({ id: 'b', cards: [{ id: 'c' }] as never })] }, 'batches[0].cards[0].title'],
      [{ version: 1, widgets: [{ id: 'w', title: 'x', updatedAt: 3 }] }, 'widgets[0].updatedAt'],
      [{ version: 1, widgets: [{ id: 'w', title: 'x', state: 'thinking' }] }, 'widgets[0].state'],
    ];
    for (const [input, problem] of cases) {
      const text = typeof input === 'string' ? input : JSON.stringify(input);
      expect(parseTodayFile(text), text).toEqual({ ok: false, problem });
    }
  });
});

describe('小组件的状态', () => {
  it('它正在写第一版 / 没写成 / 排了更新节奏', () => {
    const parsed = parseTodayFile(
      JSON.stringify({
        version: 1,
        widgets: [
          { id: 'w1', title: '开销', state: 'creating' },
          { id: 'w2', title: '行业动态', state: 'failed', schedule: '每天 8:00' },
        ],
      })
    );
    expect(parsed.ok && parsed.file.widgets.map((w) => [w.id, w.state, w.schedule])).toEqual([
      ['w1', 'creating', null],
      ['w2', 'failed', '每天 8:00'],
    ]);
  });
});

describe('日程进展 / 灵感:各读各的', () => {
  const day = {
    localDate: '2026-10-15',
    updatedAt: '2026-10-15T00:10:00Z',
    events: [
      { id: 'e1', title: '周会', start: '2026-10-15T09:00:00+08:00', end: '2026-10-15T10:00:00+08:00', joinUrl: 'https://meet.google.com/abc', color: '#4F7DF3', source: 'Google 日历' },
      { id: 'e2', title: '妈妈生日', allDay: true },
    ],
  };

  it('读懂了:没写的可选格给默认', () => {
    const parsed = parseTodayFile(JSON.stringify({ version: 1, dayInProgress: day }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.file.day.state !== 'ok') throw new Error('应读懂');
    expect(parsed.file.day.value.events[0]).toMatchObject({ joinUrl: 'https://meet.google.com/abc', allDay: false, description: '' });
    expect(parsed.file.day.value.events[1]).toMatchObject({ start: null, end: null, allDay: true, joinUrl: null, color: null, source: null });
  });

  it('这一块写坏了只记在这一块上,简报照读', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...day, localDate: '10/15' }, 'dayInProgress.localDate'],
      [{ ...day, events: [{ id: 'x', title: '没时间' }] }, 'dayInProgress.events[0].start'],
      [{ ...day, events: [{ id: 'x', title: '坏时间', start: '明早' }] }, 'dayInProgress.events[0].start'],
      [{ ...day, events: [{ id: 'x', title: '会', start: '2026-10-15T09:00:00Z', joinUrl: 'http://zoom.us/j/1' }] }, 'dayInProgress.events[0].joinUrl'],
      [{ ...day, events: [{ id: 'x', title: '会', start: '2026-10-15T09:00:00Z', joinUrl: 'javascript:alert(1)' }] }, 'dayInProgress.events[0].joinUrl'],
      [{ ...day, events: [{ id: 'x', title: '会', start: '2026-10-15T09:00:00Z', color: 'blue' }] }, 'dayInProgress.events[0].color'],
    ];
    for (const [dayInProgress, problem] of cases) {
      const parsed = parseTodayFile(JSON.stringify({ version: 1, batches: [batch({ id: 'b1' })], dayInProgress }));
      expect(parsed.ok, problem).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.file.day, problem).toEqual({ state: 'invalid', problem });
      expect(parsed.file.batches).toHaveLength(1);
    }
    const ideas = parseTodayFile(JSON.stringify({ version: 1, ideas: { items: [{ id: 'i1', title: '没有那句话' }] } }));
    expect(ideas.ok && ideas.file.ideas).toEqual({ state: 'invalid', problem: 'ideas.items[0].prompt' });
  });

  it('灵感:读出每一条和它的分组', () => {
    const parsed = parseTodayFile(
      JSON.stringify({ version: 1, ideas: { items: [{ id: 'i1', title: '整理本周开销', prompt: '帮我把这周的开销整理成表', emoji: '💰', category: '生活' }] } })
    );
    expect(parsed.ok && parsed.file.ideas).toEqual({
      state: 'ok',
      value: { updatedAt: null, items: [{ id: 'i1', title: '整理本周开销', description: '', prompt: '帮我把这周的开销整理成表', emoji: '💰', category: '生活' }] },
    });
  });
});

describe('feedOrder / dayOf', () => {
  it('新的一天在上,同一天里日记 > 晚报 > 早报', () => {
    const b = (id: string, kind: TodayBatch['kind'], localDate: string): TodayBatch => ({ id, kind, localDate, pushedAt: null, messageId: null, cards: [] });
    const order = feedOrder([b('m14', 'morning', '2026-10-14'), b('m15', 'morning', '2026-10-15'), b('d15', 'diary', '2026-10-15'), b('e15', 'evening', '2026-10-15')]);
    expect(order.map((x) => x.id)).toEqual(['d15', 'e15', 'm15', 'm14']);
  });

  it('按本地日历日认今天 / 昨天', () => {
    const now = new Date(2026, 9, 15, 0, 30);
    expect(dayOf('2026-10-15', now)).toBe('today');
    expect(dayOf('2026-10-14', now)).toBe('yesterday');
    expect(dayOf('2026-10-13', now)).toBe('other');
    expect(dayOf('2026-10-01', new Date(2026, 9, 2, 8))).toBe('yesterday');
  });
});

describe('ideaGroups', () => {
  it('按第一次出现的先后分组,没写分组的排最后', () => {
    const idea = (id: string, category: string | null): TodayIdea => ({ id, title: id, description: '', prompt: id, emoji: null, category });
    const groups = ideaGroups([idea('a', '工作'), idea('b', null), idea('c', '生活'), idea('d', '工作'), idea('e', ' ')]);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['工作', ['a', 'd']],
      ['生活', ['c']],
      [null, ['b', 'e']],
    ]);
  });
});
