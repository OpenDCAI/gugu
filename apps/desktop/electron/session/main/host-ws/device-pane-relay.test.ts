import { describe, expect, it } from 'vitest';
import { SESSION_HOST_PANE, type SessionHostPaneSubscribe } from '@shared/lib/ipc/session-host-device-frames';
import { createRemotePaneRoute } from '@main/core/session-timeline/remote-pane';
import { installDevicePaneRelay } from './device-pane-relay';
import type { FrameSessionHost } from './frame-host';

type Handler = (event: unknown, payload: unknown) => unknown;

function fakeHost() {
  const handlers = new Map<string, Handler>();
  const host = {
    ipcMain: {
      handle: (channel: string, handler: Handler) => void handlers.set(channel, handler),
      removeHandler: (channel: string) => void handlers.delete(channel),
    },
    onConnectionClosed: () => () => undefined,
    sendTo: () => true,
  } as unknown as FrameSessionHost;
  const call = (channel: string, payload: unknown) => handlers.get(channel)!({ sender: { id: 7 } }, payload);
  return { host, call };
}

describe('device pane relay', () => {
  // 桌面发的就是这个形状(remote-pane-viewer.ts 用 satisfies 绑在同一个类型上)。订上了,闲置回收才知道有人在看。
  it('a desktop subscribing with the shared payload shape counts as watching that session', () => {
    const route = createRemotePaneRoute();
    const { host, call } = fakeHost();
    installDevicePaneRelay(host, route);
    const payload: SessionHostPaneSubscribe = { subscriptionId: 'sub-1', sessionId: 'sess-1', browser: true, pages: true, external: true };

    call(SESSION_HOST_PANE.subscribe, payload);

    expect(route.watching('sess-1')).toBe(true);
  });

  it('a subscribe without a session id fails loudly and registers nobody', () => {
    const route = createRemotePaneRoute();
    const { host, call } = fakeHost();
    installDevicePaneRelay(host, route);

    expect(() => call(SESSION_HOST_PANE.subscribe, { subscriptionId: 'sub-1' })).toThrow(/sessionId/);
    expect(route.watching('sess-1')).toBe(false);
  });
});
