import { describe, expect, it } from 'vitest';
import { composeHostIpc, type HostIpc, type HostIpcInvokeEvent } from './host-ipc';

type Handler = (event: HostIpcInvokeEvent, ...args: unknown[]) => unknown;

function fakeIpc(name: string) {
  const handlers = new Map<string, Handler>();
  const broadcasts: Array<[string, unknown]> = [];
  const ipc: HostIpc = {
    ipcMain: {
      handle: (channel, listener) => void handlers.set(channel, listener),
      removeHandler: (channel) => void handlers.delete(channel),
      on: () => {},
      removeListener: () => {},
    },
    broadcast: (channel, data) => void broadcasts.push([channel, data]),
    createMessageChannel: () => ({
      port1: { postMessage() {}, on() {}, close() {} },
      port2: { from: name },
    }),
  };
  return { ipc, handlers, broadcasts, name };
}

describe('composeHostIpc', () => {
  it('registers one handler on every transport and mints ports on the originating one', () => {
    const a = fakeIpc('a');
    const b = fakeIpc('b');
    const composite = composeHostIpc([a.ipc, b.ipc]);
    let minted: unknown = null;
    composite.ipcMain.handle('wire:connect', (event) => {
      minted = composite.createMessageChannel(event).port2;
      return 'ok';
    });
    expect(a.handlers.has('wire:connect')).toBe(true);
    expect(b.handlers.has('wire:connect')).toBe(true);

    const eventFromB: HostIpcInvokeEvent = { sender: { id: 9, postMessage() {} } };
    b.handlers.get('wire:connect')!(eventFromB);
    expect(minted).toEqual({ from: 'b' });

    const eventFromA: HostIpcInvokeEvent = { sender: { id: 1, postMessage() {} } };
    a.handlers.get('wire:connect')!(eventFromA);
    expect(minted).toEqual({ from: 'a' });

    composite.broadcast('agents.changed', { n: 1 });
    expect(a.broadcasts).toEqual([['agents.changed', { n: 1 }]]);
    expect(b.broadcasts).toEqual([['agents.changed', { n: 1 }]]);
  });

  it('returns the single transport untouched', () => {
    const a = fakeIpc('a');
    expect(composeHostIpc([a.ipc])).toBe(a.ipc);
  });
});
