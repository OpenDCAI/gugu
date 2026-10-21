import { describe, expect, it, vi } from 'vitest';
import type { SessionpagePaneOpenRequest } from '@gugu/session-core/session-record/contract';
import { SESSION_HOST_PANE } from '@shared/lib/ipc/session-host-device-frames';
import { startRemotePaneViewer, type RemotePaneViewerDeps } from './remote-pane-viewer';

const request = (requestId: string, sessionId = 'conv-1', target: SessionpagePaneOpenRequest['target'] = { kind: 'file', path: '/srv/app/a.ts' }): SessionpagePaneOpenRequest => ({
  requestId,
  sessionId,
  target,
  intent: 'pinned',
});

function fakeLink(pending: SessionpagePaneOpenRequest[] = []) {
  let push: ((event: unknown) => void) | null = null;
  let reconnect: (() => void) | null = null;
  const order: string[] = [];
  const calls: Array<[string, unknown]> = [];
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push([channel, payload]);
    if (channel === SESSION_HOST_PANE.subscribe) {
      order.push('subscribe');
      return { pending };
    }
    return { accepted: true };
  });
  const link = {
    invoke,
    onOpenEvent: vi.fn((cb: (event: unknown) => void) => {
      order.push('events');
      push = cb;
      return vi.fn();
    }),
    onReconnected: vi.fn((cb: () => void) => {
      reconnect = cb;
      return vi.fn();
    }),
  };
  const acks = () => calls.filter(([channel]) => channel === SESSION_HOST_PANE.opened).map(([, payload]) => payload);
  const subscribes = () => calls.filter(([channel]) => channel === SESSION_HOST_PANE.subscribe).map(([, payload]) => payload);
  return {
    link,
    order,
    acks,
    subscribes,
    calls,
    push: (subscriptionId: string, r: SessionpagePaneOpenRequest) => push?.({ type: 'taskpage.pane.open', subscriptionId, request: r }),
    reconnect: () => reconnect?.(),
  };
}

function start(overrides: Partial<RemotePaneViewerDeps> & { link: RemotePaneViewerDeps['link'] }) {
  const open = overrides.open ?? vi.fn(() => ({ ok: true as const }));
  let n = 0;
  const stop = startRemotePaneViewer({
    deviceId: 'dev-1',
    sessionId: 'conv-1',
    browser: true,
    newId: () => `pane-${++n}`,
    ...overrides,
    open,
  });
  return { stop, open };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('看着别的机器上的一条会话:那台机器上的 open_in_tab 开在这里', () => {
  it('先挂推送再订阅,报上浏览器格有无,订阅应答里攒着的照开并逐条回话', async () => {
    const fake = fakeLink([request('q-1'), request('q-2', 'conv-1', { kind: 'browser', url: 'http://localhost:3000/' })]);
    const { open } = start({ link: fake.link });
    await flush();
    expect(fake.order).toEqual(['events', 'subscribe']);
    expect(fake.subscribes()).toEqual([{ subscriptionId: 'pane-1', sessionId: 'conv-1', browser: true, pages: true, external: true }]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(fake.acks()).toEqual([
      { requestId: 'q-1', subscriptionId: 'pane-1', ok: true },
      { requestId: 'q-2', subscriptionId: 'pane-1', ok: true },
    ]);
  });

  it('推来的开完回成功;没开成回闭集原因;开的时候抛了回 open_failed', async () => {
    const fake = fakeLink();
    const open = vi
      .fn()
      .mockReturnValueOnce({ ok: true })
      .mockReturnValueOnce({ ok: false, failure: 'no_browser' })
      .mockImplementationOnce(() => {
        throw new Error('pane gone');
      });
    start({ link: fake.link, open });
    await flush();
    fake.push('pane-1', request('r-1'));
    fake.push('pane-1', request('r-2', 'conv-1', { kind: 'browser', url: 'https://example.com/' }));
    fake.push('pane-1', request('r-3'));
    expect(fake.acks()).toEqual([
      { requestId: 'r-1', subscriptionId: 'pane-1', ok: true },
      { requestId: 'r-2', subscriptionId: 'pane-1', ok: false, failure: 'no_browser' },
      { requestId: 'r-3', subscriptionId: 'pane-1', ok: false, failure: 'open_failed' },
    ]);
  });

  it('开没开成晚一拍才知道的(群里的文件要先读出它在哪个群,F112):知道了再回;读失败回 open_failed', async () => {
    const fake = fakeLink();
    const open = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, failure: 'open_failed' })
      .mockRejectedValueOnce(new Error('network down'));
    start({ link: fake.link, open });
    await flush();
    fake.push('pane-1', request('g-1', 'conv-1', { kind: 'browser', url: 'gugu-file://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }));
    fake.push('pane-1', request('g-2', 'conv-1', { kind: 'browser', url: 'gugu-file://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }));
    await flush();
    expect(fake.acks()).toEqual([
      { requestId: 'g-1', subscriptionId: 'pane-1', ok: false, failure: 'open_failed' },
      { requestId: 'g-2', subscriptionId: 'pane-1', ok: false, failure: 'open_failed' },
    ]);
  });

  it('别的会话 / 别的订阅的请求不开;同一条请求只开一次', async () => {
    const fake = fakeLink([request('dup')]);
    const { open } = start({ link: fake.link });
    await flush();
    fake.push('pane-1', request('dup'));
    fake.push('pane-1', request('x', 'conv-other'));
    fake.push('pane-other', request('y'));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('连接断了又连上:换一条新订阅重订,断线期间攒下的照开', async () => {
    const fake = fakeLink();
    const { open } = start({ link: fake.link });
    await flush();
    fake.reconnect();
    await flush();
    expect(fake.subscribes().map((s) => (s as { subscriptionId: string }).subscriptionId)).toEqual(['pane-1', 'pane-2']);
    fake.push('pane-1', request('stale'));
    fake.push('pane-2', request('fresh'));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('不看了就退订,之后推来的不再开', async () => {
    const fake = fakeLink();
    const { stop, open } = start({ link: fake.link });
    await flush();
    stop();
    fake.push('pane-1', request('late'));
    expect(open).not.toHaveBeenCalled();
    expect(fake.calls).toContainEqual([SESSION_HOST_PANE.unsubscribe, 'pane-1']);
  });
});
