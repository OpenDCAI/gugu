/*
 * 2026-10-28:远程看会话的那一端来回重连,重连后那一次快照失败了,副本停在断开前的 `working` 上;
 * 会话只剩后台命令、再没有更新进来触发 resync ⇒ 输入框一直「排队」。重连后取不到就按退避再取。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveClientHandle } from '../../api/client';
import type { AttachOptions } from '../../api/connect';
import { WireError } from '../../api/protocol';
import type { LiveSnapshot } from '../protocol';
import { ReplicaState } from './state';

type State = { lifecycle: string };

const snapshot = (generation: number, lifecycle: string): LiveSnapshot<State> => ({
  generation,
  sequence: 0,
  timestamp: 0,
  data: { lifecycle },
});

function fakeUpstream(first: State['lifecycle']) {
  let options: AttachOptions | undefined;
  const snapshotFn = vi.fn<() => Promise<LiveSnapshot<State>>>().mockResolvedValueOnce(snapshot(1, first));
  const handle: LiveClientHandle<State> = {
    topic: 'session.state:conv-1',
    snapshot: snapshotFn,
    attach: async (_push, attachOptions) => {
      options = attachOptions;
      return () => {};
    },
    asLiveSource: () => {
      throw new Error('not used');
    },
  };
  return { handle, snapshotFn, reattach: () => options?.onReattach?.() };
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe('ReplicaState refresh after reattach', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a failed refresh after reconnect is retried until it lands: working → ready', async () => {
    const upstream = fakeUpstream('working');
    const replica = new ReplicaState(upstream.handle, { logger });
    await replica.ready;
    expect(replica.current().lifecycle).toBe('working');

    upstream.snapshotFn
      .mockRejectedValueOnce(new WireError('DISCONNECTED', 'link dropped again'))
      .mockResolvedValueOnce(snapshot(2, 'ready'));
    upstream.reattach();
    await vi.advanceTimersByTimeAsync(0);
    expect(replica.current().lifecycle, 'first refetch failed').toBe('working');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(replica.current().lifecycle).toBe('ready');
    expect(upstream.snapshotFn).toHaveBeenCalledTimes(3);
    await replica.dispose();
  });

  it('❌ negative: a normal reconnect fetches exactly one snapshot', async () => {
    const upstream = fakeUpstream('working');
    const replica = new ReplicaState(upstream.handle, { logger });
    await replica.ready;

    upstream.snapshotFn.mockResolvedValue(snapshot(2, 'ready'));
    upstream.reattach();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(replica.current().lifecycle).toBe('ready');
    expect(upstream.snapshotFn, 'initial seed + one refetch').toHaveBeenCalledTimes(2);
    await replica.dispose();
  });

  it('NOT_FOUND is final: reported as gone, not retried', async () => {
    const upstream = fakeUpstream('working');
    const replica = new ReplicaState(upstream.handle, { logger });
    await replica.ready;
    const gone = vi.fn();
    replica.onGone(gone);

    upstream.snapshotFn.mockRejectedValue(new WireError('NOT_FOUND', 'instance gone'));
    upstream.reattach();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(gone).toHaveBeenCalledTimes(1);
    expect(upstream.snapshotFn).toHaveBeenCalledTimes(2);
    await replica.dispose();
  });

  it('disposing stops a pending retry', async () => {
    const upstream = fakeUpstream('working');
    const replica = new ReplicaState(upstream.handle, { logger });
    await replica.ready;

    upstream.snapshotFn.mockRejectedValue(new WireError('DISCONNECTED', 'down'));
    upstream.reattach();
    await vi.advanceTimersByTimeAsync(0);
    await replica.dispose();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(upstream.snapshotFn).toHaveBeenCalledTimes(2);
  });

  it('a chained replica follows its upstream replica\'s reseed at once, without waiting for a later update', async () => {
    const upstream = fakeUpstream('working');
    const middle = new ReplicaState(upstream.handle, { logger });
    await middle.ready;
    // 下游(比如宿主主进程那几份副本的订阅者)直接跟着中间这份副本。
    const downstreamHandle: LiveClientHandle<State> = {
      topic: 'session.state:conv-1/downstream',
      snapshot: () => middle.snapshot() as Promise<LiveSnapshot<State>>,
      attach: async (push) => middle.subscribe(push),
      asLiveSource: () => {
        throw new Error('not used');
      },
    };
    const downstream = new ReplicaState(downstreamHandle, { logger });
    await downstream.ready;
    expect(downstream.current().lifecycle).toBe('working');

    upstream.snapshotFn.mockResolvedValueOnce(snapshot(2, 'ready'));
    upstream.reattach();
    await vi.advanceTimersByTimeAsync(0);

    expect(middle.current().lifecycle).toBe('ready');
    expect(downstream.current().lifecycle, 'no further update needed').toBe('ready');
    await downstream.dispose();
    await middle.dispose();
  });
});
