import { ok, type Unsubscribe } from '@gugu/session-shared';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineContract, liveLog, liveModel, liveState, procedure } from '../../api/define';
import { WireError } from '../../api/protocol';
import { createTestWire } from '../../testing';
import { LiveLog } from '../log';
import { createLiveModelHost } from '../mutations';
import type { LiveSource } from '../protocol';
import { ReplicaLog } from './log';
import { ReplicaState } from './state';

// @@@replica-failed-ready — `ready` 拒了的副本必须把自己那次 attach 放掉。判据全是结构量:服务端此刻挂着几个
// 订阅、同一主题反复失败以后最后一个真持有者放手时订阅是否归零、重试拿到的是不是新的 state、更新到不到。
// 「服务端处理完了」用一次 `ping` 往返当屏障:同一条连接上的消息按序处理,ping 回来时前面的 detach / update
// 都已经落地 —— ❌ 墙钟。

const countSchema = z.object({ count: z.number() });
const api = defineContract({
  ping: procedure({ input: z.void().optional(), output: z.void() }),
  counter: liveModel({
    key: z.object({ id: z.string() }),
    states: { state: liveState({ data: countSchema }) },
  }),
  output: liveLog({ key: z.object({ id: z.string() }) }),
});

const wires: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const wire of wires.splice(0)) wire.dispose();
});

function rig() {
  const host = createLiveModelHost(api.counter);
  const log = new LiveLog({ generation: 1000 });
  /** 服务端此刻挂着的订阅数(counter 与 output 分开数)。 */
  const active = { counter: 0, output: 0 };
  /** 服务端累计收到的订阅次数 —— 证明「attach 确实成功过」这个前提。 */
  const subscribed = { counter: 0, output: 0 };
  /** 接下来 N 次快照失败。 */
  const faults = { counterSnapshots: 0, outputSnapshots: 0 };

  const counted = (inner: LiveSource): LiveSource => ({
    snapshot: async () => {
      if (faults.counterSnapshots > 0) {
        faults.counterSnapshots -= 1;
        throw new WireError('HANDLER_ERROR', 'snapshot failed');
      }
      return inner.snapshot();
    },
    subscribe: async (cb, options) => {
      const unsubscribe = await inner.subscribe(cb, options);
      active.counter += 1;
      subscribed.counter += 1;
      return () => {
        active.counter -= 1;
        unsubscribe();
      };
    },
  });

  const logSnapshot = log.snapshot.bind(log);
  const logSubscribe = log.subscribe.bind(log);
  log.snapshot = () => {
    if (faults.outputSnapshots > 0) {
      faults.outputSnapshots -= 1;
      throw new WireError('HANDLER_ERROR', 'log snapshot failed');
    }
    return logSnapshot();
  };
  log.subscribe = (cb): Unsubscribe => {
    const unsubscribe = logSubscribe(cb);
    active.output += 1;
    subscribed.output += 1;
    return () => {
      active.output -= 1;
      unsubscribe();
    };
  };

  const wire = createTestWire(api, {
    ping: () => undefined,
    counter: {
      kind: 'liveModelProvider',
      contract: api.counter,
      // 没有这个实例 ⇒ undefined ⇒ 控制器给 missingLiveSource(同步抛 NOT_FOUND),与运行时里还没建好的会话同一条路。
      resolveState: (key, name) => {
        const state = host.get(key as { id: string })?.states[name as 'state'];
        return state ? counted(state) : undefined;
      },
      runMutation: async () => ok({ data: undefined, cursors: [] }),
    },
    output: () => log,
  });
  wires.push(wire);
  return {
    wire,
    host,
    log,
    active,
    subscribed,
    faults,
    barrier: async () => {
      await wire.client.ping();
    },
  };
}
type Rig = ReturnType<typeof rig>;

const counterReplica = (r: Rig, id: string) =>
  new ReplicaState(r.wire.client.counter.state({ id }, 'state'), { schema: countSchema });

describe('a replica whose ready rejects lets go of its attachment', () => {
  it('snapshot fails after the attach succeeded: the server subscription is released', async () => {
    const r = rig();
    r.host.create({ id: 'a' }, { state: { count: 0 } });
    r.faults.counterSnapshots = 1;

    const replica = counterReplica(r, 'a');
    await expect(replica.ready).rejects.toMatchObject({ message: 'snapshot failed' });
    await r.barrier();

    expect(r.subscribed.counter, 'attach did succeed — this is the case that leaked').toBe(1);
    expect(r.active.counter).toBe(0);
  });

  it('failures on the same key do not pile up: the last real holder releasing brings the server to zero', async () => {
    const r = rig();
    r.host.create({ id: 'a' }, { state: { count: 0 } });
    r.faults.counterSnapshots = 3;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(counterReplica(r, 'a').ready).rejects.toMatchObject({ message: 'snapshot failed' });
    }

    const holder = counterReplica(r, 'a');
    await holder.ready;
    await r.barrier();
    expect(r.active.counter).toBe(1);

    // 连接按主题合并推送回调:只要还有一个失败副本的回调留着,这里的 dispose 就不会发 detach。
    await holder.dispose();
    await r.barrier();
    expect(r.active.counter).toBe(0);
  });

  it('a retry is a fresh replica that seeds the current state and keeps receiving updates', async () => {
    const r = rig();
    const model = r.host.create({ id: 'a' }, { state: { count: 0 } }).states.state;
    r.faults.counterSnapshots = 1;
    await expect(counterReplica(r, 'a').ready).rejects.toMatchObject({ message: 'snapshot failed' });

    model.produce((draft) => {
      draft.count = 5;
    });
    const retry = counterReplica(r, 'a');
    await retry.ready;
    expect(retry.current()).toEqual({ count: 5 });

    model.produce((draft) => {
      draft.count = 6;
    });
    await r.barrier();
    expect(retry.current()).toEqual({ count: 6 });
    expect(r.active.counter).toBe(1);

    await retry.dispose();
  });

  it('ReplicaLog: a failed snapshot releases the log attachment too', async () => {
    const r = rig();
    r.log.append('seed\n');
    r.faults.outputSnapshots = 1;

    const replica = new ReplicaLog(r.wire.client.output.handle({ id: 's' }));
    await expect(replica.ready).rejects.toMatchObject({ message: 'log snapshot failed' });
    await r.barrier();

    expect(r.subscribed.output).toBe(1);
    expect(r.active.output).toBe(0);
  });

  it('dispose after a failed attach resolves instead of rethrowing the attach error', async () => {
    const r = rig();
    // 没有这个实例:attach 与快照都失败。
    const replica = counterReplica(r, 'missing');
    await expect(replica.ready).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(replica.dispose()).resolves.toBeUndefined();
  });
});

// @@@attach-sync-throw — 服务端 attach 时 subscribe 同步抛(实例还不存在的 keyed 主题),不能留下「已 attach」的幽灵:
// 否则实例建好以后,同一主题的下一次 attach 直接回成功、背后没有订阅,seed 得出来却再也收不到更新。
// 产品上就是「会话首次启动失败(摘要 lost、实例已拆)→ 重试起来以后,审批再也送不到手机」。
describe('an attach that fails synchronously leaves no phantom on the server', () => {
  it('after a NOT_FOUND attach, the instance appears and a new replica receives updates', async () => {
    const r = rig();
    await expect(counterReplica(r, 'late').ready).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const model = r.host.create({ id: 'late' }, { state: { count: 1 } }).states.state;
    const replica = counterReplica(r, 'late');
    await replica.ready;
    expect(replica.current()).toEqual({ count: 1 });

    model.produce((draft) => {
      draft.count = 2;
    });
    await r.barrier();

    expect(r.active.counter, 'a real server subscription backs the second attach').toBe(1);
    expect(replica.current()).toEqual({ count: 2 });
    await replica.dispose();
  });
});
