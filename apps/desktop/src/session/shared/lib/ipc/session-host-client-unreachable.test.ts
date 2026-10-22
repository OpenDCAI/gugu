// 开线器说那台机器此刻够不着(code unreachable,machine-clients 按 remoteHostReachable 判):这就是离线 ——
// 客户端停在 closed,❌ 记「连不上」、❌ 退避空转(每一轮都是一次发到离线机器、没人应答的报到);它回来时 reconnectNow 当场重开。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionHostClient, type SessionHostPipeOpener } from './session-host-client';

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('session host client: the machine is unreachable', () => {
  it('stays closed without retrying or warning, and opens at once on reconnectNow', async () => {
    vi.useFakeTimers();
    let reachable = false;
    const opens: number[] = [];
    const open = ((_handlers: Parameters<SessionHostPipeOpener>[0]) => {
      opens.push(Date.now());
      if (!reachable) return Promise.reject(Object.assign(new Error('not reachable now'), { code: 'unreachable' }));
      return Promise.resolve({ send: () => undefined, close: () => undefined });
    }) as SessionHostPipeOpener;
    const warn = vi.fn();
    const onOpenFailed = vi.fn();
    const client = createSessionHostClient(open, { retryMaxMs: 60_000, warn, onOpenFailed });

    await expect(client.api.invoke('any.channel')).rejects.toMatchObject({ code: 'unreachable' });
    expect(client.state()).toBe('closed');

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle();
    expect(opens).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect(onOpenFailed).not.toHaveBeenCalled();

    reachable = true;
    client.reconnectNow();
    await settle();
    expect(opens).toHaveLength(2);
    expect(client.state()).toBe('open');
    client.close();
  });

  it('control: any other open failure still warns and backs off', async () => {
    vi.useFakeTimers();
    let opens = 0;
    const open = ((_handlers: Parameters<SessionHostPipeOpener>[0]) => {
      opens += 1;
      return Promise.reject(new Error('no answer within 15000 ms'));
    }) as SessionHostPipeOpener;
    const warn = vi.fn();
    const client = createSessionHostClient(open, { retryMaxMs: 60_000, warn });

    await expect(client.api.invoke('any.channel')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(opens).toBeGreaterThan(1);
    expect(warn).toHaveBeenCalled();
    client.close();
  });
});
