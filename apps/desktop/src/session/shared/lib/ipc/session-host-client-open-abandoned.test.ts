// 开线器放弃了这一问(频道重订上 / 宿主刚起来)或这一次被后来的一次取代 = 「正在重连」,❌ 「连不上」:
// 当场再开,等着的调用方接着等新的那次。只有真的开不成才拒,说「连不上」。
// 手机切后台 60 s 回来,列表订阅那一问等在被放弃的那次开线上 ⇒ 一闪红「此刻连不上」(mac1 两臂各 6/6)。
import { describe, expect, it, vi } from 'vitest';
import { createSessionHostClient, type SessionHostPipeOpener } from './session-host-client';

type Step = 'open' | 'fail' | { code: string } | 'manual';

function fakeOpener(plan: Step[]) {
  const opens: number[] = [];
  const closed: number[] = [];
  const manual: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  const open = ((_handlers: Parameters<SessionHostPipeOpener>[0]) => {
    const index = opens.length;
    opens.push(index);
    const step = plan[index] ?? 'open';
    const pipe = { send: () => undefined, close: () => closed.push(index) };
    if (step === 'open') return Promise.resolve(pipe);
    if (step === 'fail') return Promise.reject(new Error('no answer'));
    if (step === 'manual') return new Promise((resolve, reject) => manual.push({ resolve: () => resolve(pipe), reject }));
    return Promise.reject(Object.assign(new Error('abandoned'), { code: step.code }));
  }) as SessionHostPipeOpener;
  return { open, opens, closed, manual };
}

const messages = { hostUnreachable: 'UNREACHABLE' };

describe('session host client: abandoned open', () => {
  it('连续替代两次:等待者只跟随有效连接;两条迟到旧线各关一次', async () => {
    const pipe = fakeOpener(['manual', 'manual', 'open']);
    const client = createSessionHostClient(pipe.open, { messages });
    const settled = vi.fn();
    const first = client.connect().then(settled);
    try {
      client.reconnectNow();
      client.reconnectNow();
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(settled).toHaveBeenCalledTimes(1);
      pipe.manual[1]!.resolve();
      pipe.manual[0]!.resolve();
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(pipe.closed).toEqual([1, 0]);
      expect(pipe.opens).toHaveLength(3);
      expect(client.state()).toBe('open');
    } finally {
      client.close();
      for (const attempt of pipe.manual) attempt.resolve();
      await first.catch(() => undefined);
    }
  });

  it('旧开线一直不结算:首读仍随替代连接立即继续', async () => {
    const pipe = fakeOpener(['manual', 'open']);
    const client = createSessionHostClient(pipe.open, { messages });
    const settled = vi.fn();
    const first = client.connect().then(settled);
    try {
      client.reconnectNow();
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(client.state()).toBe('open');
      expect(settled).toHaveBeenCalledTimes(1);
      await first;
    } finally {
      client.close();
      pipe.manual[0]!.reject(new Error('cleanup'));
      await first.catch(() => undefined);
    }
  });

  it('旧开线不结算,替代连接失败:首读当场拿到真正失败', async () => {
    const pipe = fakeOpener(['manual', 'fail']);
    const client = createSessionHostClient(pipe.open, { messages });
    const failed = vi.fn();
    const first = client.connect().catch(failed);
    try {
      client.reconnectNow();
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'UNREACHABLE' }));
    } finally {
      client.close();
      pipe.manual[0]!.reject(new Error('cleanup'));
      await first;
    }
  });

  it('close 当场结束等待开线的调用,不等 opener 结算', async () => {
    const pipe = fakeOpener(['manual']);
    const client = createSessionHostClient(pipe.open, { messages });
    const failed = vi.fn();
    const first = client.connect().catch(failed);
    client.close();
    try {
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(failed).toHaveBeenCalledTimes(1);
    } finally {
      pipe.manual[0]!.reject(new Error('cleanup'));
      await first;
    }
  });

  for (const code of ['channel_resubscribed', 'host_restarted']) {
    it(`开线被放弃(${code}):当场再开,等着的调用方拿到新的那次,❌ 拿「连不上」`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
      try {
        const pipe = fakeOpener([{ code }, 'open']);
        const client = createSessionHostClient(pipe.open, { messages });
        await expect(client.connect()).resolves.toBeUndefined();
        // ❌ 等退避:一拍计时器都没推就已经开了第二次
        expect(pipe.opens).toHaveLength(2);
        expect(client.state()).toBe('open');
        client.close();
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it('真的开不成:照样拒「连不上」,按退避再试', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const pipe = fakeOpener(['fail', 'open']);
      const client = createSessionHostClient(pipe.open, { messages });
      await expect(client.connect()).rejects.toThrow('UNREACHABLE');
      expect(client.state()).toBe('closed');
      expect(pipe.opens).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(pipe.opens).toHaveLength(2);
      expect(client.state()).toBe('open');
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('开线中被 reconnectNow 取代,旧的那次后来失败:等它的调用方接着等新的那次', async () => {
    const pipe = fakeOpener(['manual', 'manual']);
    const client = createSessionHostClient(pipe.open, { messages });
    const first = client.connect();
    client.reconnectNow();
    expect(pipe.opens).toHaveLength(2);
    pipe.manual[0]!.reject(new Error('timeout'));
    pipe.manual[1]!.resolve();
    await expect(first).resolves.toBeUndefined();
    expect(client.state()).toBe('open');
    client.close();
  });

  it('开线中被取代,旧的那次后来成功:关掉它,等它的调用方接着等新的那次', async () => {
    const pipe = fakeOpener(['manual', 'manual']);
    const client = createSessionHostClient(pipe.open, { messages });
    const first = client.connect();
    client.reconnectNow();
    pipe.manual[0]!.resolve();
    pipe.manual[1]!.resolve();
    await expect(first).resolves.toBeUndefined();
    expect(client.state()).toBe('open');
    client.close();
  });

  it('close 之后被放弃的那次:拒,❌ 再开', async () => {
    const pipe = fakeOpener(['manual']);
    const client = createSessionHostClient(pipe.open, { messages });
    const first = client.connect();
    client.close();
    pipe.manual[0]!.reject(Object.assign(new Error('abandoned'), { code: 'channel_resubscribed' }));
    await expect(first).rejects.toThrow();
    expect(pipe.opens).toHaveLength(1);
  });
});
