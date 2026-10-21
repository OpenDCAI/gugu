// 那台机器上的宿主刚(重新)起来(`taskhost.ready`,经开线器的 watchPeerRestart 报上来):客户端当场重开,
// ❌ 等那一问的开线超时、❌ 等退避、❌ 等心跳判死。听者挂在客户端「想连着它」的整段上,❌ 挂在某一条管道上。
import { describe, expect, it, vi } from 'vitest';
import { createSessionHostClient, type SessionHostPipeOpener } from './session-host-client';

function fakeOpener(plan: Array<'hang' | 'open' | 'fail'>) {
  const opens: number[] = [];
  const closed: number[] = [];
  let restart: (() => void) | null = null;
  let watched = 0;
  let unwatched = 0;
  const open = ((_handlers: Parameters<SessionHostPipeOpener>[0]) => {
    const index = opens.length;
    opens.push(index);
    const step = plan[index] ?? 'open';
    if (step === 'hang') return new Promise(() => undefined);
    if (step === 'fail') return Promise.reject(new Error('no answer'));
    return Promise.resolve({ send: () => undefined, close: () => closed.push(index) });
  }) as SessionHostPipeOpener;
  open.watchPeerRestart = (onRestart) => {
    watched += 1;
    restart = onRestart;
    return () => {
      unwatched += 1;
      restart = null;
    };
  };
  return {
    open,
    opens,
    closed,
    restart: () => restart?.(),
    counts: () => ({ watched, unwatched }),
  };
}

describe('session host client: peer restart', () => {
  it('退避等着时(上一次开线失败了、下一拍还没到)那台机器的宿主起来了:取消计时、当场重开,不推任何计时器', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const pipe = fakeOpener(['fail', 'open']);
      const client = createSessionHostClient(pipe.open);
      await client.connect().catch(() => undefined);
      expect(client.state()).toBe('closed');
      expect(pipe.opens).toHaveLength(1);
      pipe.restart();
      expect(pipe.opens).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(client.state()).toBe('open');
      // 退避那一拍已作废:推过原来的计时也不会多开一次
      await vi.advanceTimersByTimeAsync(5000);
      expect(pipe.opens).toHaveLength(2);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('开线还在路上时宿主起来了:当场再开一次,新的那次接上', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const pipe = fakeOpener(['hang', 'open']);
      const client = createSessionHostClient(pipe.open);
      void client.connect().catch(() => undefined);
      expect(client.state()).toBe('connecting');
      pipe.restart();
      expect(pipe.opens).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(client.state()).toBe('open');
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('开着的窗口:旧窗口关掉、当场开新的', async () => {
    const pipe = fakeOpener(['open', 'open']);
    const client = createSessionHostClient(pipe.open);
    await client.connect();
    pipe.restart();
    expect(pipe.closed).toEqual([0]);
    expect(pipe.opens).toHaveLength(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(client.state()).toBe('open');
    client.close();
  });

  it('只在想连时才听,只挂一份;close 摘掉', async () => {
    const pipe = fakeOpener(['open', 'open']);
    const client = createSessionHostClient(pipe.open);
    expect(pipe.counts()).toEqual({ watched: 0, unwatched: 0 });
    await client.connect();
    pipe.restart();
    await Promise.resolve();
    await Promise.resolve();
    expect(pipe.counts()).toEqual({ watched: 1, unwatched: 0 });
    client.close();
    expect(pipe.counts()).toEqual({ watched: 1, unwatched: 1 });
    pipe.restart();
    expect(pipe.opens).toHaveLength(2);
  });
});
