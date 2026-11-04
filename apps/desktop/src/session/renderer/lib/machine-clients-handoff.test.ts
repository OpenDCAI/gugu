// @vitest-environment jsdom
/**
 * 计划内换线对外照「通着」说(2026-10-27 owner:「每次打开都闪一下」)。
 *
 * 开机时到那台机器的频道从咕咕云换到设备连接,开着的窗口以交接关掉、当场开新的。侧栏那颗点、文件树、审阅都读
 * `machineLinkState`:这一段它要一直是 open,❌ 掉成 closed / connecting(remote-hosts-store 会读成「重新连接」,
 * 文件树变「无响应」)。新窗口开好算一次「变通」(onMachineReconnected):新窗口上的订阅要重订、落空的问要重来。
 *
 * 判据能判假吗:machineLinkState 不把 switching 说成 open,第一条的状态序列红;onMachineReconnected 照旧只看
 * machineLinkState,换线换好不算变通,第一条的计数红。
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionHostPipeOpener } from '@shared/lib/ipc/session-host-client';

type Handlers = Parameters<SessionHostPipeOpener>[0];
const windows = vi.hoisted(() => [] as Array<{ onFrame(frame: string | Uint8Array): void; onClose(reason: string, options?: { handoff?: boolean }): void }>);
const sent = vi.hoisted(() => [] as string[]);
const peerProtocol = vi.hoisted(() => ({ value: null as number | null }));
const matchServerVersion = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@shared/remote-hosts', async (importOriginal) => {
  const opener = Object.assign(
    (handlers: Handlers) => {
      windows.push(handlers);
      if (peerProtocol.value !== null) handlers.onFrame(JSON.stringify({ t: 'hello', v: peerProtocol.value, sender: 0 }));
      return Promise.resolve({ send: (frame: string | Uint8Array) => { if (typeof frame === 'string') sent.push(frame); }, close: () => undefined });
    },
    { watchPeerRestart: () => () => undefined }
  );
  const bridge = {
    openSessionHost: () => opener,
    listDevices: () => [{ id: 'd22', label: 'd22', isOnline: true }],
    subscribeDevices: () => () => undefined,
    matchServerVersion,
  };
  return {
    ...(await importOriginal<typeof import('@shared/remote-hosts')>()),
    findRemoteHostsBridge: () => bridge,
    remoteHostReachable: () => true,
  };
});

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: { invoke: () => Promise.resolve([]), eventSend: () => {}, eventOn: () => () => {}, getPathForFile: () => '' },
});
const { closeMachineClient, machineClient, machineLinkHandingOff, machineLinkState, onMachineReconnected, reportMachineOutdated, subscribeMachineLink } = await import('./machine-clients');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('到那台机器的线:计划内换线', () => {
  it('keeps a protocol-4 host open and delivers plain text through its existing methods', async () => {
    windows.length = 0;
    sent.length = 0;
    peerProtocol.value = 4;
    const client = machineClient('d22')!;
    try {
      await client.connect();
      expect(machineLinkState('d22')).toBe('open');
      const input = { conversationId: 'session', text: 'plain text', clientRequestId: 'text-input' };
      const delivered = client.api.invoke('sessionTimeline.sessionSend', input);
      await flush();
      const request = sent.map(frame => JSON.parse(frame)).find(frame => frame.t === 'invoke');
      expect(request).toMatchObject({ channel: 'sessionTimeline.sessionSend', args: [input] });
      windows[0].onFrame(JSON.stringify({ t: 'result', id: request.id, ok: true, value: { id: 'text-input' } }));
      await expect(delivered).resolves.toEqual({ id: 'text-input' });
    } finally { closeMachineClient('d22'); peerProtocol.value = null; }
  });

  it('still rejects protocol-3 method names', async () => {
    windows.length = 0;
    peerProtocol.value = 3;
    try {
      await machineClient('d22')!.connect();
      expect(machineLinkState('d22')).toBe('tooOld');
    } finally { closeMachineClient('d22'); peerProtocol.value = null; }
  });

  it('换线这一段对外一直是 open;新窗口开好算一次变通', async () => {
    windows.length = 0;
    await machineClient('d22')!.connect();
    const seen: string[] = [];
    const off = subscribeMachineLink('d22', () => seen.push(machineLinkState('d22')));
    const reconnected = vi.fn();
    const unwatch = onMachineReconnected('d22', reconnected);

    windows[0].onClose('channel switching transport', { handoff: true });
    expect(machineLinkState('d22')).toBe('open');
    expect(machineLinkHandingOff('d22')).toBe(true);
    await flush();

    expect(windows).toHaveLength(2);
    expect(machineLinkHandingOff('d22')).toBe(false);
    expect(seen, '侧栏、文件树读到的状态 ❌ 掉线').toEqual(['open', 'open']);
    expect(reconnected).toHaveBeenCalledTimes(1);
    off();
    unwatch();
    closeMachineClient('d22');
  });

  it('真断了(❌ 交接):照旧说 closed', async () => {
    windows.length = 0;
    await machineClient('d22')!.connect();
    windows[0].onClose('frame not delivered');
    expect(machineLinkState('d22')).toBe('closed');
    expect(machineLinkHandingOff('d22')).toBe(false);
    closeMachineClient('d22');
  });

  it('marks a connected machine outdated and requests version matching when a required RPC is missing', async () => {
    windows.length = 0;
    matchServerVersion.mockClear();
    await machineClient('d22')!.connect();

    reportMachineOutdated('d22');
    reportMachineOutdated('d22');

    expect(machineLinkState('d22')).toBe('tooOld');
    expect(matchServerVersion).toHaveBeenCalledOnce();
    expect(matchServerVersion).toHaveBeenCalledWith('d22');
    closeMachineClient('d22');
  });
});

describe('换版请求失败时 tooOld 放锁', () => {
  it.each(['false', 'reject'] as const)('a late %s from the previous connection cannot release the current match', async (outcome) => {
    windows.length = 0;
    const first = Promise.withResolvers<boolean>();
    const second = Promise.withResolvers<boolean>();
    matchServerVersion.mockReset();
    matchServerVersion.mockResolvedValue(true).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    try {
      await machineClient('d22')!.connect();
      reportMachineOutdated('d22');
      windows[0].onClose('channel switching transport', { handoff: true });
      await flush();
      expect(windows).toHaveLength(2);
      expect(machineLinkState('d22')).toBe('open');
      reportMachineOutdated('d22');
      expect(matchServerVersion).toHaveBeenCalledTimes(2);
      expect(machineLinkState('d22')).toBe('tooOld');

      if (outcome === 'false') first.resolve(false);
      else first.reject(new Error('old version request failed'));
      await flush();
      const stateAfterOldResult = machineLinkState('d22');
      reportMachineOutdated('d22');
      expect({ stateAfterOldResult, matchRequests: matchServerVersion.mock.calls.length })
        .toEqual({ stateAfterOldResult: 'tooOld', matchRequests: 2 });
    } finally {
      first.resolve(false);
      second.resolve(false);
      await flush();
      closeMachineClient('d22');
    }
  });

  it.each(['false', 'reject'] as const)('a late %s cannot clear an outdated hello from the replacement connection', async (outcome) => {
    windows.length = 0;
    const first = Promise.withResolvers<boolean>();
    matchServerVersion.mockReset();
    matchServerVersion.mockReturnValueOnce(first.promise);
    try {
      await machineClient('d22')!.connect();
      reportMachineOutdated('d22');
      peerProtocol.value = 3;
      windows[0].onClose('channel switching transport', { handoff: true });
      await flush();
      expect(windows).toHaveLength(2);
      expect(machineLinkState('d22')).toBe('tooOld');

      if (outcome === 'false') first.resolve(false);
      else first.reject(new Error('old version request failed'));
      await flush();
      expect(machineLinkState('d22')).toBe('tooOld');
      expect(matchServerVersion).toHaveBeenCalledOnce();
    } finally {
      first.resolve(false);
      await flush();
      closeMachineClient('d22');
      peerProtocol.value = null;
    }
  });

  it('match 说不是旧版 / 请求被拒:状态回到 open,这条路径还能再问', async () => {
    windows.length = 0;
    try {
      await machineClient('d22')!.connect();
      const reconnected = vi.fn();
      const off = onMachineReconnected('d22', reconnected);
      matchServerVersion.mockClear();
      matchServerVersion.mockResolvedValueOnce(false);
      reportMachineOutdated('d22');
      expect(machineLinkState('d22')).toBe('tooOld');
      await flush();
      expect(machineLinkState('d22')).toBe('open');

      matchServerVersion.mockRejectedValueOnce(new Error('bridge down'));
      reportMachineOutdated('d22');
      expect(machineLinkState('d22')).toBe('tooOld');
      await flush();
      expect(machineLinkState('d22')).toBe('open');
      expect(reconnected, '放锁不是重连').not.toHaveBeenCalled();
      off();
    } finally {
      closeMachineClient('d22');
    }
  });
})
