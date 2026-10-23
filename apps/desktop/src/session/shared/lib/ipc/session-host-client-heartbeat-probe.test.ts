// #156 心跳标明是心跳:设备连接据此把它当探活(只装心跳的那一批几秒没回 = 那台机器没了,见 remoteSessionHost)。
// 办事的帧照旧不带标记,按办事的期限等。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeHostWsMessage } from './host-ws-protocol';
import { createSessionHostClient, type SessionHostPipeOpener } from './session-host-client';

afterEach(() => vi.useRealTimers());

describe('session host client: heartbeats are marked as heartbeats', () => {
  it('每拍发一次心跳,带 heartbeat 标记;办事的帧不带', async () => {
    vi.useFakeTimers();
    const sent: Array<{ t: string; kind: string | undefined }> = [];
    const open = (() =>
      Promise.resolve({
        send: (frame: string | Uint8Array, kind?: 'heartbeat') => {
          sent.push({ t: (decodeHostWsMessage(frame) as { t: string }).t, kind });
        },
        close: () => undefined,
      })) as SessionHostPipeOpener;
    const client = createSessionHostClient(open, { heartbeatMs: 5_000 });
    await client.connect();
    void client.api.invoke('app.getAppVersion').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    client.close();
    expect(sent.filter((m) => m.t === 'hb')).toEqual([
      { t: 'hb', kind: 'heartbeat' },
      { t: 'hb', kind: 'heartbeat' },
    ]);
    expect(sent.find((m) => m.t === 'invoke')).toEqual({ t: 'invoke', kind: undefined });
  });
});
