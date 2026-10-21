// 窗口多半已死(dropIfSilent):发问前当场判,判中就先重开、这一问发在新窗口上;没到门槛就照用原窗口,❌ 白白重开。
// 看门狗按拍判的是同一个判据。两个信号各有门槛,都从宿主的关窗规矩推出来(宿主一整拍没收到这边任何东西就关):
//   收帧:两拍(HOST_WS_STALE_MS);这边被冻住(看门狗没跑到):一拍 − 这边的心跳周期。钟是注入的,不碰墙钟。
import { describe, expect, it, vi } from 'vitest';
import { decodeHostWsMessage, encodeHostWsMessage, HOST_WS_HEARTBEAT_MS, HOST_WS_STALE_MS } from './host-ws-protocol';
import { createSessionHostClient, SESSION_HOST_CLIENT_HEARTBEAT_MS, type SessionHostPipeOpener } from './session-host-client';

function fakeOpener() {
  const pipes: Array<{ sent: Array<{ t: string; channel?: string }>; closed: boolean; frame: (f: string | Uint8Array) => void }> = [];
  const open = ((handlers: Parameters<SessionHostPipeOpener>[0]) => {
    const pipe = { sent: [] as Array<{ t: string; channel?: string }>, closed: false, frame: handlers.onFrame };
    pipes.push(pipe);
    return Promise.resolve({
      send: (frame: string | Uint8Array) => {
        if (pipe.closed) throw new Error('closed');
        pipe.sent.push(decodeHostWsMessage(frame) as { t: string; channel?: string });
      },
      close: () => {
        pipe.closed = true;
      },
    });
  }) as SessionHostPipeOpener;
  return { open, pipes };
}

const invokesOn = (pipe: { sent: Array<{ t: string; channel?: string }> }) => pipe.sent.filter((m) => m.t === 'invoke').map((m) => m.channel);
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};
const hb = () => encodeHostWsMessage({ t: 'hb' });

// 两条路:WebSocket(浏览器即时回 pong,这边不发 hb)、设备通道(这边每 SESSION_HOST_CLIENT_HEARTBEAT_MS 发一次 hb)。
const PATHS = [
  { name: 'WebSocket', heartbeatMs: 0, frozenMs: HOST_WS_HEARTBEAT_MS },
  { name: '设备通道', heartbeatMs: SESSION_HOST_CLIENT_HEARTBEAT_MS, frozenMs: HOST_WS_HEARTBEAT_MS - SESSION_HOST_CLIENT_HEARTBEAT_MS },
] as const;

/** 开着一条窗口,然后「冻住」frozenS 秒:钟往前走,计时器一拍都不跑;醒来时 socket 里缓着的旧帧先交上来。 */
async function frozenThenAsk(heartbeatMs: number, frozenS: number) {
  let t = 1_000_000;
  const pipe = fakeOpener();
  const client = createSessionHostClient(pipe.open, { now: () => t, heartbeatMs });
  await client.connect();
  t += frozenS * 1000;
  pipe.pipes[0]!.frame(hb());
  void client.api.invoke('sessionTimeline.sessionsSubscribe', { subscriptionId: 's' }).catch(() => undefined);
  await settle();
  // 读数取在收摊之前:close() 会把开着的窗口也关掉
  const closedAtAsk = pipe.pipes.map((p) => p.closed);
  client.close();
  return { ...pipe, closedAtAsk };
}

describe('session host client: silent window judged when asking', () => {
  it('门槛都从宿主的关窗规矩推出来;设备通道的心跳是宿主半拍', () => {
    expect(HOST_WS_STALE_MS).toBe(2 * HOST_WS_HEARTBEAT_MS);
    expect(SESSION_HOST_CLIENT_HEARTBEAT_MS).toBe(HOST_WS_HEARTBEAT_MS / 2);
  });

  it('心跳不比宿主一拍短:当场报错,❌ 带着一个判不出冻住的门槛跑', () => {
    expect(() => createSessionHostClient(fakeOpener().open, { heartbeatMs: HOST_WS_HEARTBEAT_MS })).toThrow(/heartbeatMs/);
  });

  for (const path of PATHS) {
    describe(path.name, () => {
      it(`冻住刚超过门槛(${path.frozenMs / 1000} s)醒来就问:缓着的旧帧不算数,先重开,这一问发在新窗口上`, async () => {
        const pipe = await frozenThenAsk(path.heartbeatMs, path.frozenMs / 1000 + 1);
        expect(pipe.pipes).toHaveLength(2);
        expect(pipe.closedAtAsk).toEqual([true, false]);
        expect(invokesOn(pipe.pipes[0]!)).toEqual([]);
        expect(invokesOn(pipe.pipes[1]!)).toEqual(['sessionTimeline.sessionsSubscribe']);
      });

      for (const frozenS of [25, 35]) {
        it(`冻住 ${frozenS} s(宿主一拍到两拍之间)醒来就问:先重开`, async () => {
          const pipe = await frozenThenAsk(path.heartbeatMs, frozenS);
          expect(pipe.pipes).toHaveLength(2);
          expect(invokesOn(pipe.pipes[1]!)).toEqual(['sessionTimeline.sessionsSubscribe']);
        });
      }

      it(`冻住不到门槛(${path.frozenMs / 1000 - 2} s):照用原窗口,❌ 重开`, async () => {
        const pipe = await frozenThenAsk(path.heartbeatMs, path.frozenMs / 1000 - 2);
        expect(pipe.pipes).toHaveLength(1);
        expect(pipe.closedAtAsk).toEqual([false]);
        expect(invokesOn(pipe.pipes[0]!)).toEqual(['sessionTimeline.sessionsSubscribe']);
      });

      it('正好在门槛上:还算活着(超过才算死)', async () => {
        const pipe = await frozenThenAsk(path.heartbeatMs, path.frozenMs / 1000);
        expect(pipe.pipes).toHaveLength(1);
      });
    });
  }

  it('醒着、帧也一直在来、看门狗一直在跑:跑多久都不算静默', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout'] });
    try {
      let t = 1_000_000;
      const pipe = fakeOpener();
      const client = createSessionHostClient(pipe.open, { now: () => t, heartbeatMs: SESSION_HOST_CLIENT_HEARTBEAT_MS });
      await client.connect();
      for (let i = 0; i < 120; i += 1) {
        t += 1000;
        if (i % 20 === 0) pipe.pipes[0]!.frame(hb());
        await vi.advanceTimersByTimeAsync(1000);
      }
      void client.api.invoke('x.y').catch(() => undefined);
      await settle();
      expect(pipe.pipes).toHaveLength(1);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('线被中间设备掐死(醒着、看门狗在跑,两拍收不到一帧):看门狗当场重开', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout'] });
    try {
      let t = 1_000_000;
      const pipe = fakeOpener();
      const client = createSessionHostClient(pipe.open, { now: () => t });
      await client.connect();
      for (let i = 0; i < HOST_WS_STALE_MS / 1000 + 6; i += 1) {
        t += 1000;
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(pipe.pipes).toHaveLength(2);
      expect(pipe.pipes[0]!.closed).toBe(true);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('冻住醒来、还没人发问:看门狗那一拍先判再记,当场重开(先记再判就抹掉了这段空白)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout'] });
    try {
      let t = 1_000_000;
      const pipe = fakeOpener();
      const client = createSessionHostClient(pipe.open, { now: () => t });
      await client.connect();
      t += HOST_WS_HEARTBEAT_MS + 5000;
      pipe.pipes[0]!.frame(hb());
      await vi.advanceTimersByTimeAsync(HOST_WS_HEARTBEAT_MS / 4);
      expect(pipe.pipes).toHaveLength(2);
      expect(pipe.pipes[0]!.closed).toBe(true);
      expect(client.state()).toBe('open');
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
