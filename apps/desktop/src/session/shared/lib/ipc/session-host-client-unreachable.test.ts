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
  it('allows a later explicit connect without a peer-version source to recover a protocol refusal', async () => {
    let upgraded = false;
    const open = vi.fn(async () => {
      if (!upgraded) throw Object.assign(new Error('update required'), { code: 'server_outdated' });
      return { send: () => undefined, close: () => undefined };
    });
    const client = createSessionHostClient(open);
    try {
      await expect(client.connect()).rejects.toMatchObject({ code: 'server_outdated' });
      upgraded = true;
      await expect(client.connect()).resolves.toBeUndefined();
      expect(open).toHaveBeenCalledTimes(2);
    } finally { client.close(); }
  });

  it('keeps missing version heartbeats paused but retries on a real host restart signal', async () => {
    let upgraded = false;
    let changed: () => void = () => undefined;
    let restarted: () => void = () => undefined;
    const open = Object.assign(vi.fn(async () => {
      if (!upgraded) throw Object.assign(new Error('update required'), { code: 'server_outdated' });
      return { send: () => undefined, close: () => undefined };
    }), { watchPeerRestart: (cb: () => void) => { restarted = cb; return () => undefined; } });
    const client = createSessionHostClient(open, {
      peerVersion: () => null,
      subscribeReachability: cb => { changed = cb; return () => undefined; },
    });
    try {
      await expect(client.connect()).rejects.toMatchObject({ code: 'server_outdated' });
      for (let i = 0; i < 10; i += 1) { changed(); await settle(); }
      expect(open).toHaveBeenCalledTimes(1);
      upgraded = true;
      restarted();
      await settle();
      expect(client.state()).toBe('open');
      expect(open).toHaveBeenCalledTimes(2);
    } finally { client.close(); }
  });

  it('keeps a protocol refusal paused across online heartbeats, until manual retry or a new peer version', async () => {
    vi.useFakeTimers();
    let version: string | null = '0.2.58-beta.1050.1';
    let changed: () => void = () => undefined;
    const open = vi.fn(async () => {
      if (!version || version.endsWith('1050.1')) throw Object.assign(new Error('update required'), { code: 'server_outdated' });
      return { send: () => undefined, close: () => undefined };
    });
    const warn = vi.fn();
    const client = createSessionHostClient(open, {
      isReachable: () => true,
      peerVersion: () => version,
      subscribeReachability: listener => { changed = listener; return () => undefined; },
      warn,
    });
    try {
      await expect(client.api.invoke('any.channel')).rejects.toMatchObject({ code: 'server_outdated' });
      for (let beat = 0; beat < 10; beat += 1) {
        changed();
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(open).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);

      version = null;
      changed();
      await settle();
      expect(open).toHaveBeenCalledTimes(1);
      version = '0.2.58-beta.1050.1';

      client.reconnectNow();
      await settle();
      expect(open).toHaveBeenCalledTimes(2);

      version = '0.2.58-beta.1061.1';
      changed();
      await settle();
      expect(open).toHaveBeenCalledTimes(3);
      expect(client.state()).toBe('open');
    } finally { client.close(); }
  });

  it.each(['client_outdated', 'server_outdated'])('does not retry a rejected protocol window (%s)', async (code) => {
    vi.useFakeTimers();
    const open = vi.fn(async () => { throw Object.assign(new Error('protocol mismatch'), { code }); });
    const failed = vi.fn();
    const client = createSessionHostClient(open, { onOpenFailed: failed });
    try {
      await expect(client.api.invoke('any.channel')).rejects.toMatchObject({ code });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(open).toHaveBeenCalledTimes(1);
      expect(failed).toHaveBeenCalledTimes(1);
    } finally { client.close(); }
  });

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
