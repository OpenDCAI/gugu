import { describe, expect, it } from 'vitest';
import { WireError } from '../api/protocol';
import { deferred } from '../testing';
import { LiveFollower } from './follower';
import type { LiveSnapshot } from './protocol';

describe('LiveFollower.refresh', () => {
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
