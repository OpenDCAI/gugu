import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  localInvoke: vi.fn(async () => 'local'),
  remoteInvoke: vi.fn(async () => 'remote'),
}));

vi.mock('./electron-api', () => ({
  findSessionHostBridge: () => ({
    invoke: mocks.localInvoke,
    eventSend: vi.fn(),
    eventOn: () => () => {},
    getPathForFile: () => '',
  }),
}));
vi.mock('./machine-clients', () => ({
  machineClient: () => ({ api: { invoke: mocks.remoteInvoke } }),
  onEachMachine: () => () => {},
}));

import { rpc, rpcOn } from './ipc';
import { machineRegistry } from './machine-routing';

afterEach(() => {
  vi.clearAllMocks();
  machineRegistry.forgetMachine('device-b');
});

describe('rpcOn', () => {
  // 挂父会话:child 在本机、父会话在别的机器上 —— 这一步只能在 child 这台做。
  it('null means this machine even when an argument names something on another machine', async () => {
    machineRegistry.register('device-b', ['parent-on-b']);

    await rpcOn(null).sessions.setSessionParent('child-here', 'parent-on-b');

    expect(mocks.localInvoke).toHaveBeenCalledWith('sessions.setSessionParent', 'child-here', 'parent-on-b');
    expect(mocks.remoteInvoke).not.toHaveBeenCalled();
  });

  it('the routed rpc would have sent that same call to the other machine', async () => {
    machineRegistry.register('device-b', ['parent-on-b']);

    await rpc.sessions.setSessionParent('child-here', 'parent-on-b');

    expect(mocks.remoteInvoke).toHaveBeenCalled();
    expect(mocks.localInvoke).not.toHaveBeenCalled();
  });

  it('a named machine still goes there', async () => {
    await rpcOn('device-b').sessions.setSessionParent('child-on-b', 'parent-here');

    expect(mocks.remoteInvoke).toHaveBeenCalledWith('sessions.setSessionParent', 'child-on-b', 'parent-here');
    expect(mocks.localInvoke).not.toHaveBeenCalled();
  });
});
