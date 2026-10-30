import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@gugu/session-shared/logger';
import { WireError } from '../api/protocol';
import { deferred } from '../testing';
import { LiveFollower } from './follower';
import type { LiveSnapshot } from './protocol';

describe('LiveFollower.refresh', () => {
  it('summarizes repeated gap diagnostics while one recovery is pending', async () => {
    const read = deferred<LiveSnapshot<number>>();
    const warn = vi.fn();
    const info = vi.fn();
    const follower = new LiveFollower<number>(() => read.promise, { seed: () => undefined, apply: () => ({ ok: true }) }, {
      label: 'test', logger: { warn, info } as unknown as Logger,
    });
    follower.seed({ generation: 1, sequence: 0, timestamp: 0, data: 0 });
    for (let i = 1; i <= 20; i += 1) follower.applyUpdate({ generation: 1, baseSequence: i, sequence: i + 1, timestamp: 0, delta: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    read.resolve({ generation: 1, sequence: 21, timestamp: 0, data: 21 });
    await follower.refresh();
    expect(info).toHaveBeenCalledWith('wire test resync summary', expect.objectContaining({ events: 20, suppressed: 19 }));
    expect(follower.cursor).toMatchObject({ sequence: 21 });
  });

  // 上游实例拆掉又马上建回来:两次 gap 紧挨着。第一次重取还在途(拿到的是拆掉那一刻的 NOT_FOUND)时第二次被要了 ——
  // 丢掉第二次,就停在 NOT_FOUND 上,新实例再也接不上。
  it('runs a refresh requested while one is in flight, after it settles', async () => {
    const first = deferred<LiveSnapshot<number>>();
    const fetches = [() => first.promise, async () => ({ generation: 2, sequence: 0, timestamp: 0, data: 7 })];
    let seeded: number | undefined;
    const follower = new LiveFollower<number>(() => fetches.shift()!(), {
      seed: (snapshot) => {
        seeded = snapshot.data;
      },
      apply: () => ({ ok: true }),
    }, { label: 'test' });

    const one = follower.refresh();
    const two = follower.refresh();
    first.reject(new WireError('NOT_FOUND', 'no instance yet'));
    await Promise.all([one, two]);

    expect(fetches).toHaveLength(0);
    expect(seeded).toBe(7);
  });

  it('still rejects a lone refresh that fails', async () => {
    const follower = new LiveFollower<number>(async () => {
      throw new WireError('NOT_FOUND', 'no instance');
    }, { seed: () => undefined, apply: () => ({ ok: true }) }, { label: 'test' });
    await expect(follower.refresh()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('LiveFollower seed-first', () => {
  const update = (baseSequence: number, generation = 1) => ({
    generation,
    baseSequence,
    sequence: baseSequence + 1,
    timestamp: 0,
    delta: baseSequence + 1,
  });

  function setup() {
    const applied: unknown[] = [];
    const resyncs: unknown[] = [];
    const warn = vi.fn();
    let fetches = 0;
    const follower = new LiveFollower<number>(
      async () => {
        fetches += 1;
        return { generation: 1, sequence: 9, timestamp: 0, data: 9 };
      },
      {
        seed: () => undefined,
        apply: (u) => {
          applied.push(u.delta);
          return { ok: true };
        },
      },
      {
        label: 'test',
        logger: { warn, info: vi.fn() } as unknown as Logger,
        instrumentation: { resync: (event) => resyncs.push(event) },
      }
    );
    return { follower, applied, resyncs, warn, fetches: () => fetches };
  }

  // #974:attach 先于快照,快照在途时推来的每条更新都各要一次快照,压在正在恢复的 worker 上。
  it('holds updates that arrive before the first seed without resyncing', () => {
    const { follower, applied, resyncs, fetches } = setup();
    follower.applyUpdate(update(1));
    follower.applyUpdate(update(2));
    expect(applied).toEqual([]);
    expect(resyncs).toEqual([]);
    expect(fetches()).toBe(0);
  });

  it('replays held updates past the snapshot and skips those inside it', () => {
    const { follower, applied, resyncs } = setup();
    follower.applyUpdate(update(1));
    follower.applyUpdate(update(2));
    follower.applyUpdate(update(3));
    follower.seed({ generation: 1, sequence: 2, timestamp: 0, data: 2 });
    expect(applied).toEqual([3, 4]);
    expect(follower.cursor).toEqual({ generation: 1, sequence: 4 });
    expect(resyncs).toEqual([]);
  });

  it('recovers through one warned resync when the held updates still leave a gap', async () => {
    const { follower, applied, resyncs, warn } = setup();
    follower.applyUpdate(update(5));
    follower.applyUpdate(update(6));
    follower.seed({ generation: 1, sequence: 2, timestamp: 0, data: 2 });
    await vi.waitFor(() => expect(follower.cursor).toEqual({ generation: 1, sequence: 9 }));
    expect(applied).toEqual([]);
    expect(resyncs[0]).toMatchObject({ reason: 'sequence-gap', details: { expected: 2, got: 5 } });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops held updates from an older generation and resyncs on a newer one', () => {
    const { follower, applied, resyncs } = setup();
    follower.applyUpdate(update(7, 1));
    follower.applyUpdate(update(0, 3));
    follower.seed({ generation: 2, sequence: 0, timestamp: 0, data: 0 });
    expect(applied).toEqual([]);
    expect(resyncs).toEqual([
      expect.objectContaining({ reason: 'generation', details: { local: 2, incoming: 3 } }),
    ]);
  });

  it('treats a duplicate or stale update as a no-op', () => {
    const { follower, applied, resyncs, fetches } = setup();
    follower.seed({ generation: 2, sequence: 5, timestamp: 0, data: 5 });
    follower.applyUpdate(update(4, 2));
    follower.applyUpdate(update(1, 2));
    follower.applyUpdate(update(8, 1));
    expect(applied).toEqual([]);
    expect(resyncs).toEqual([]);
    expect(fetches()).toBe(0);
    follower.applyUpdate(update(5, 2));
    expect(applied).toEqual([6]);
    expect(follower.cursor).toEqual({ generation: 2, sequence: 6 });
  });
});
