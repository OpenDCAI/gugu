import { describe, expect, it } from 'vitest';
import type { TimelineAfterResult } from '@gugu/session-core/session-record';
import { createStandInTimeline, standInTurns } from './stand-in-timeline';

function manualTimers() {
  const runs = new Map<number, () => void>();
  let next = 0;
  return {
    setInterval: (run: () => void) => {
      next += 1;
      runs.set(next, run);
      return next;
    },
    clearInterval: (handle: unknown) => {
      runs.delete(handle as number);
    },
    tick: () => {
      for (const run of [...runs.values()]) run();
    },
    get live() {
      return runs.size;
    },
  };
}

describe('stand-in timeline(没有记录可读的会话照样打得开)', () => {
  it('快照只有这个人发出去的第一句话;没有就是空转录', () => {
    const [turn] = standInTurns({ sessionId: 'c1', firstMessage: '  hi @[a.png](/r/a.png) ', createdAt: 1000 });
    expect(turn).toMatchObject({
      initiator: 'user',
      startedAt: 1000,
      // 了结的一轮:❌ 读作「正在跑」(处理中 / 停止键)。
      outcome: { kind: 'done' },
      items: [{ kind: 'message', role: 'user', text: 'hi @[a.png](/r/a.png)', at: 1000 }],
    });
    expect(standInTurns({ sessionId: 'c1', firstMessage: null, createdAt: null })).toEqual([]);
    expect(standInTurns({ sessionId: 'c1', firstMessage: 'x', createdAt: null })[0]).not.toHaveProperty('startedAt');
  });

  it('同世代取增量:空批;别的世代:reset + 快照', () => {
    const timeline = createStandInTimeline({ sessionId: 'c1', firstMessage: 'hi', createdAt: null, recordAvailable: () => false });
    const { cursor } = timeline.getSnapshot();
    expect(timeline.getAfter(cursor)).toMatchObject({ ok: true, batch: { turns: [] } });
    expect(timeline.getAfter({ epoch: 'other', seq: 3 })).toMatchObject({ ok: false, reset: 'epoch_changed' });
    expect(timeline.getOlder({ beforeTurnId: 'x' })).toMatchObject({ turns: [], hasOlder: false });
  });

  it('真记录出现(再试一次成功了):订阅的人收到一批换了世代的空增量 = 整份重拉,只推一次', () => {
    const timers = manualTimers();
    let available = false;
    const timeline = createStandInTimeline({
      sessionId: 'c1',
      firstMessage: 'hi',
      createdAt: null,
      recordAvailable: () => available,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    const seen: TimelineAfterResult[] = [];
    timeline.subscribe(timeline.getSnapshot().cursor, (result) => seen.push(result));
    timers.tick();
    expect(seen).toEqual([]);
    available = true;
    timers.tick();
    timers.tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ok && seen[0]!.batch.cursor.epoch).not.toBe(timeline.epoch);
    expect(timers.live).toBe(0);
  });

  it('退订 / 拆掉:定时器一个不留', () => {
    const timers = manualTimers();
    const timeline = createStandInTimeline({
      sessionId: 'c1',
      firstMessage: 'hi',
      createdAt: null,
      recordAvailable: () => false,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    const stop = timeline.subscribe(null, () => undefined);
    timeline.subscribe(null, () => undefined);
    stop();
    expect(timers.live).toBe(1);
    timeline.dispose();
    expect(timers.live).toBe(0);
  });
});
