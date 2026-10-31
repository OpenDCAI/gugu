// 「宿主起来了」(taskhost.ready):一份宿主处理器头一回订上自己的设备频道时说一声,只说一次;
// 频道断了又订上(处理器没换,窗口都还在)❌ 再说;没装宿主处理器的频道(多账号 host)❌ 说。
import { describe, expect, it, vi } from 'vitest';

let onStatus: ((status: string) => void) | null = null;
vi.mock('../../../../apps/desktop/electron/realtime-channel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/electron/realtime-channel')>()),
  subscribeAuthenticatedElectronRealtimeChannel: async (_client: unknown, _channel: unknown, options: { onStatus: (status: string) => void }) => {
    onStatus = options.onStatus;
    return () => undefined;
  },
}));

import { SESSION_HOST_READY_EVENT } from '../../../../apps/desktop/src/session/shared/lib/ipc/session-host-device-frames';
import { createDesktopDeviceRpcSubscription } from '../../../../apps/desktop/electron/device-rpc-responder';

function fakeSupabase() {
  const sent: unknown[] = [];
  const channel = {
    on: () => channel,
    subscribe: () => channel,
    send: async (message: { payload: unknown }) => {
      sent.push(message.payload);
      return 'ok';
    },
  };
  return { sent, supabase: { realtime: { setAuth: () => undefined }, channel: () => channel, removeChannel: () => undefined } };
}

describe('device RPC subscription: host ready', () => {
  it('announces once, on the first SUBSCRIBED of a host handler set', async () => {
    const { sent, supabase } = fakeSupabase();
    const subscribe = createDesktopDeviceRpcSubscription({
      supabase: supabase as never,
      warn: () => undefined,
      createHandlers: () => ({ handlers: {}, dispose: () => undefined }),
    });
    await subscribe({ deviceId: 'dev-1' } as never);
    expect(sent).toEqual([]);
    onStatus!('SUBSCRIBED');
    onStatus!('CHANNEL_ERROR');
    onStatus!('SUBSCRIBED');
    await Promise.resolve();
    expect(sent).toEqual([{ type: SESSION_HOST_READY_EVENT }]);
  });

  it('says nothing on a channel that hosts no task host', async () => {
    const { sent, supabase } = fakeSupabase();
    const subscribe = createDesktopDeviceRpcSubscription({ supabase: supabase as never, warn: () => undefined });
    await subscribe({ deviceId: 'dev-1' } as never);
    onStatus!('SUBSCRIBED');
    await Promise.resolve();
    expect(sent).toEqual([]);
  });
});
