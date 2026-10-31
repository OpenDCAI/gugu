// 计划内换线(开机时到那台机器的频道从咕咕云换到设备连接):开着的窗口随旧频道关掉,开线器报 `handoff`。
// 客户端当场开新窗口(❌ 等 1 s 退避),这一段记成 switching(❌ closed / connecting —— 界面会读成断线、重连),
// 新窗口开好回到 open;开不成才落到 closed。2026-10-27 owner:「每次打开都闪一下」,网络其实一直好好的。
//
// 判据能判假吗:onClosed 不看 handoff(照旧 closed + 退避),第一条的状态序列与「当场开」两处都红;
// connect() 无条件 setState('connecting'),状态序列里多出 connecting,红。
import { describe, expect, it, vi } from 'vitest';
import { createSessionHostClient, type SessionHostConnectionState, type SessionHostPipeOpener } from './session-host-client';

type Handlers = Parameters<SessionHostPipeOpener>[0];

function fakeOpener(plan: Array<'open' | 'fail' | 'hang'>) {
  const windows: Handlers[] = [];
  const open = ((handlers: Handlers) => {
    const step = plan[windows.length] ?? 'open';
    windows.push(handlers);
    if (step === 'hang') return new Promise(() => undefined);
    if (step === 'fail') return Promise.reject(new Error('no answer'));
    return Promise.resolve({ send: () => undefined, close: () => undefined });
  }) as SessionHostPipeOpener;
  return { open, windows };
}

function recordStates(client: ReturnType<typeof createSessionHostClient>): SessionHostConnectionState[] {
  const seen: SessionHostConnectionState[] = [];
  client.onStateChange((state) => seen.push(state));
  return seen;
}

describe('session host client: 计划内换线', () => {
  it('窗口随换线关掉:当场开新窗口,状态 open → switching → open,❌ 经过 closed / connecting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const pipe = fakeOpener(['open', 'open']);
      const client = createSessionHostClient(pipe.open);
      await client.connect();
      const states = recordStates(client);

      pipe.windows[0].onClose('channel switching transport', { handoff: true });
      expect(client.state()).toBe('switching');
      expect(pipe.windows, '当场开新窗口,❌ 等退避').toHaveLength(2);

      await vi.advanceTimersByTimeAsync(0);
      expect(client.state()).toBe('open');
      expect(states).toEqual(['switching', 'open']);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('旧窗口上没回的问照旧当场失败;换线中发的问等新窗口', async () => {
    const pipe = fakeOpener(['open', 'open']);
    const client = createSessionHostClient(pipe.open);
    await client.connect();
    const inFlight = client.api.invoke('x');
    await new Promise((resolve) => setTimeout(resolve, 0));
    pipe.windows[0].onClose('channel switching transport', { handoff: true });
    await expect(inFlight).rejects.toThrow();

    await client.connect();
    expect(client.state()).toBe('open');
    expect(pipe.windows).toHaveLength(2);
    client.close();
  });

  it('新窗口开不成:落到 closed(那时才是断了),照常退避重连', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const pipe = fakeOpener(['open', 'fail', 'open']);
      const client = createSessionHostClient(pipe.open);
      await client.connect();
      pipe.windows[0].onClose('channel switching transport', { handoff: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(client.state()).toBe('closed');
      await vi.advanceTimersByTimeAsync(1000);
      expect(pipe.windows).toHaveLength(3);
      expect(client.state()).toBe('open');
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('不是换线的关(对面没了、帧没送到):照旧 closed + 退避', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const pipe = fakeOpener(['open', 'open']);
      const client = createSessionHostClient(pipe.open);
      await client.connect();
      pipe.windows[0].onClose('frame not delivered');
      expect(client.state()).toBe('closed');
      expect(pipe.windows).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(pipe.windows).toHaveLength(2);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
