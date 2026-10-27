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

vi.mock('@shared/remote-hosts', async (importOriginal) => {
  const opener = Object.assign(
    (handlers: Handlers) => {
      windows.push(handlers);
      return Promise.resolve({ send: () => undefined, close: () => undefined });
    },
    { watchPeerRestart: () => () => undefined }
  );
  const bridge = {
    openSessionHost: () => opener,
    listDevices: () => [{ id: 'd22', label: 'd22', isOnline: true }],
    subscribeDevices: () => () => undefined,
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
const { closeMachineClient, machineClient, machineLinkHandingOff, machineLinkState, onMachineReconnected, subscribeMachineLink } = await import('./machine-clients');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('到那台机器的线:计划内换线', () => {
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
});
