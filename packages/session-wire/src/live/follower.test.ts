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
