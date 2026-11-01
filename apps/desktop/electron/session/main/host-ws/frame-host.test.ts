// FrameSessionHost ↔ 通用客户端,中间是内存里的一条线(设备连接的形状:没有 ping,靠 hb)。
// 钉三件事:只推订了的频道、wire 传输能收发且断线时报断、宿主策略挡掉的命名空间对端调不到。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionHostClient,
  type SessionHostClient,
  type SessionHostPipeOpener,
} from '@shared/lib/ipc/session-host-client';
import { broadcastDeviceSessionHostEvent, installDeviceSessionHost, remoteInvokePolicyForCaller } from './device-session-host';
import { FrameSessionHost, type FrameSocket, type FrameInvokePolicy } from './frame-host';
import { decodeHostWsMessage, encodeHostWsMessage, HOST_WS_PROTOCOL_VERSION } from '@shared/lib/ipc/host-ws-protocol';
import { sessionpageAgentProvisionedEvent } from '@shared/lib/ipc/sessionpage-identity-contract';

function memoryLink(host: FrameSessionHost, policy?: FrameInvokePolicy) {
  const serverSockets: Array<{ drop(): void }> = [];
  const open: SessionHostPipeOpener = async ({ onFrame, onClose }) => {
    let serverFrame: ((frame: string | Uint8Array) => void) | null = null;
    let serverClose: (() => void) | null = null;
    let closed = false;
    const drop = () => {
      if (closed) return;
      closed = true;
      serverClose?.();
      onClose('dropped');
    };
    const socket: FrameSocket = {
      send: (frame) => {
        if (!closed) queueMicrotask(() => onFrame(frame));
      },
      close: drop,
      onFrame: (cb) => (serverFrame = cb),
      onClose: (cb) => (serverClose = cb),
    };
    host.attach(socket, { policy });
    serverSockets.push({ drop });
    return {
      send: (frame) => {
        if (closed) throw new Error('closed');
        queueMicrotask(() => serverFrame?.(frame));
      },
      close: drop,
    };
  };
  return { open, serverSockets };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('FrameSessionHost over a device-shaped link', () => {
  let client: SessionHostClient | null = null;
  afterEach(() => {
    client?.close();
    client = null;
  });

  it('首读正在等旧开线:替代连接接通就把同一问交到宿主,只执行一次', async () => {
    const host = new FrameSessionHost();
    const snapshot = { cursor: { epoch: 'test', seq: 1 }, turns: [], settlements: [], hasOlder: false };
    const read = vi.fn(() => snapshot);
    host.ipcMain.handle('sessionTimeline.sessionSnapshot', read);
    const link = memoryLink(host);
    let opens = 0;
    client = createSessionHostClient((handlers) => ++opens === 1 ? new Promise(() => undefined) : link.open(handlers));
    const got: unknown[] = [];
    const firstRead = client.api.invoke('sessionTimeline.sessionSnapshot', { conversationId: 'test-session' }).then((value) => got.push(value));
    client.reconnectNow();
    await flush();
    expect(got).toEqual([snapshot]);
    expect(read).toHaveBeenCalledTimes(1);
    await firstRead;
  });

  it('sends no broadcasts before the first subscription, even when opening never finishes', () => {
    const host = new FrameSessionHost();
    const frames: Array<string | Uint8Array> = [];
    let receive: (frame: string | Uint8Array) => void = () => { throw new Error('not attached'); };
    const detach = host.attach({
      send: (frame) => { frames.push(frame); },
      close: () => undefined,
      onFrame: (handler) => { receive = handler; },
      onClose: () => undefined,
    });
    try {
      frames.length = 0; // The host hello is a direct protocol message.
      host.broadcast('pty:data.other', 'unsolicited');
      expect(frames).toEqual([]);

      receive(JSON.stringify({ t: 'sub', channel: 'pty:data.mine' }));
      host.broadcast('pty:data.other', 'still unrelated');
      host.broadcast('pty:data.mine', 'subscribed');
      expect(frames.map((frame) => JSON.parse(String(frame)))).toEqual([
        { t: 'event', channel: 'pty:data.mine', data: 'subscribed' },
      ]);

      receive(JSON.stringify({ t: 'unsub', channel: 'pty:data.mine' }));
      host.broadcast('pty:data.mine', 'after unsub');
      expect(frames).toHaveLength(1);
    } finally {
      detach();
    }
  });

  it('pushes only the channels the client subscribed to', async () => {
    const host = new FrameSessionHost({ appVersion: () => '9.9.9' });
    const link = memoryLink(host);
    client = createSessionHostClient(link.open, { subscribeEvents: true });
    const got: unknown[] = [];
    const off = client.api.eventOn('pty:data.s1', (data) => got.push(data));
    await client.connect();
    await flush();
    host.broadcast('pty:data.s1', 'mine');
    host.broadcast('pty:data.s2', 'not mine');
    await flush();
    expect(got).toEqual(['mine']);
    expect(client.hello()).toEqual({ protocol: HOST_WS_PROTOCOL_VERSION, appVersion: '9.9.9' });
    off();
    await flush();
    host.broadcast('pty:data.s1', 'after unsub');
    await flush();
    expect(got).toEqual(['mine']);
  });

  it('re-subscribes after the link drops and comes back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const host = new FrameSessionHost();
      const link = memoryLink(host);
      client = createSessionHostClient(link.open, { subscribeEvents: true });
      const got: unknown[] = [];
      client.api.eventOn('conv.updated', (data) => got.push(data));
      await client.connect();
      await vi.advanceTimersByTimeAsync(1);
      link.serverSockets[0]!.drop();
      expect(client.state()).toBe('closed');
      await vi.advanceTimersByTimeAsync(1100);
      expect(client.state()).toBe('open');
      await vi.advanceTimersByTimeAsync(1);
      host.broadcast('conv.updated', 'again');
      await vi.advanceTimersByTimeAsync(1);
      expect(got).toEqual(['again']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnectNow drops an open link the far side forgot (a version switch says nothing) and opens a new one at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const before = memoryLink(new FrameSessionHost({ appVersion: () => '0.2.52' }));
      const after = memoryLink(new FrameSessionHost({ appVersion: () => '0.2.53' }));
      let current = before;
      client = createSessionHostClient((handlers) => current.open(handlers), { subscribeEvents: true });
      await client.connect();
      await vi.advanceTimersByTimeAsync(1);
      expect(client.hello()?.appVersion).toBe('0.2.52');
      // the old process is gone and told nobody: its link is never dropped, only the next heartbeat would find out
      current = after;
      client.reconnectNow();
      await vi.advanceTimersByTimeAsync(1);
      expect(client.state()).toBe('open');
      expect(client.hello()?.appVersion).toBe('0.2.53');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnectNow abandons an open still in flight (sent while the machine was away): its late reply is closed, the new link stays', async () => {
    const live = memoryLink(new FrameSessionHost({ appVersion: () => '0.2.53' }));
    let releaseStale!: (pipe: { send(frame: string | Uint8Array): void; close(): void }) => void;
    const staleClosed = vi.fn();
    let opens = 0;
    client = createSessionHostClient((handlers) => {
      opens += 1;
      // the first open went out while nobody listened: it only comes back much later
      if (opens === 1) return new Promise((resolve) => (releaseStale = resolve));
      return live.open(handlers);
    });
    void client.connect().catch(() => undefined);
    expect(client.state()).toBe('connecting');
    client.reconnectNow();
    await flush();
    expect(client.state()).toBe('open');
    expect(client.hello()?.appVersion).toBe('0.2.53');
    releaseStale({ send: () => undefined, close: staleClosed });
    await flush();
    expect(staleClosed).toHaveBeenCalledTimes(1);
    expect(client.state()).toBe('open');
    expect(client.hello()?.appVersion).toBe('0.2.53');
  });

  it('an open refused for a version says which side is too old (server_outdated / client_outdated); other failures say unreachable', async () => {
    const refuse = (code: string | null): SessionHostPipeOpener => async () => {
      throw Object.assign(new Error('refused'), code ? { code } : {});
    };
    const messages = { hostUnreachable: 'unreachable', hostTooOld: 'that machine is old', clientTooOld: 'this one is old' };
    for (const [code, text] of [['server_outdated', 'that machine is old'], ['client_outdated', 'this one is old'], [null, 'unreachable']] as const) {
      const client = createSessionHostClient(refuse(code), { messages, retryMaxMs: 60_000 });
      await expect(client.connect()).rejects.toMatchObject({ message: text, ...(code ? { code } : {}) });
      client.close();
    }
  });

  it('invokeOnce: one call through the same table and policy, no window; what that caller owned is released right after', async () => {
    const host = new FrameSessionHost();
    const seen: number[] = [];
    host.ipcMain.handle('sessionTimeline.sessionAfter', (event, input) => {
      seen.push((event as { sender: { id: number } }).sender.id);
      return { echoed: input };
    });
    const released: number[] = [];
    host.onConnectionClosed((sender) => released.push(sender));
    expect(await host.invokeOnce('sessionTimeline.sessionAfter', [{ conversationId: 'c1' }])).toEqual({ echoed: { conversationId: 'c1' } });
    expect(released).toEqual(seen);
    await expect(host.invokeOnce('browser.open', [], (channel) => !channel.startsWith('browser.'))).rejects.toThrow(/No handler/);
    await expect(host.invokeOnce('nope.missing', [])).rejects.toThrow(/No handler/);
  });

  it('refuses channels the policy keeps on the viewing computer', async () => {
    const host = new FrameSessionHost();
    host.ipcMain.handle('app.quit', () => 'quit');
    host.ipcMain.handle('tasks.getTasks', () => ['t1']);
    const link = memoryLink(host, (channel) => !channel.startsWith('app.'));
    client = createSessionHostClient(link.open);
    await expect(client.api.invoke('tasks.getTasks')).resolves.toEqual(['t1']);
    await expect(client.api.invoke('app.quit')).rejects.toThrow(/No handler registered for 'app.quit'/);
  });

  it('checks App operation arguments on a persistent frame connection as well as one-shot calls', async () => {
    const host = new FrameSessionHost();
    const run = vi.fn((_event, _verb, input) => input.name);
    host.ipcMain.handle('app.assistantAppCall', run);
    client = createSessionHostClient(memoryLink(host, remoteInvokePolicyForCaller('owner')).open);
    await expect(client.api.invoke('app.assistantAppCall', 'callProgram', { name: 'assistant_work_list' }, 'owner')).resolves.toBe('assistant_work_list');
    await expect(client.api.invoke('app.assistantAppCall', 'callProgram', { name: 'assistant_work_clear' }, 'owner')).resolves.toBe('assistant_work_clear');
    await expect(client.api.invoke('app.assistantAppCall', 'callProgram', { name: 'assistant_work_clear' }, 'other')).rejects.toThrow(/No handler/);
    await expect(client.api.invoke('app.assistantAppCall', 'callProgram', { name: 'library_write' }, 'owner')).rejects.toThrow(/No handler/);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('opens a wire transport that carries messages both ways and reports the drop', async () => {
    const host = new FrameSessionHost();
    host.ipcMain.handle('acp-wire:connect', (event) => {
      const { port1, port2 } = host.createMessageChannel();
      port1.on('message', (ev) => port1.postMessage({ echo: (ev as { data: unknown }).data }));
      event.sender.postMessage('acp-wire:port', null, [port2]);
    });
    const link = memoryLink(host);
    client = createSessionHostClient(link.open);
    const transport = await client.openWireTransport('acp-wire');
    const received: unknown[] = [];
    transport.onMessage((message) => received.push(message));
    let disconnected = false;
    transport.onDisconnect(() => (disconnected = true));
    transport.post({ kind: 'cancel', id: 'x' });
    await flush();
    expect(received).toEqual([{ echo: { kind: 'cancel', id: 'x' } }]);
    link.serverSockets[0]!.drop();
    expect(disconnected).toBe(true);
  });

  // #6264 会话开户:壳主进程播给本机窗口的同时经这里推给别的电脑 —— 没有窗口的 server 上
  // 这是唯一的出口,少了它别的电脑上那条会话一直认不出背后的 agent。
  it('pushes the shell identity events to desktops watching this machine', async () => {
    const host = installDeviceSessionHost({ appVersion: () => '9.9.9' });
    const link = memoryLink(host);
    client = createSessionHostClient(link.open, { subscribeEvents: true });
    const got: unknown[] = [];
    client.api.eventOn(sessionpageAgentProvisionedEvent.name, (data) => got.push(data));
    await client.connect();
    await flush();
    const event = { conversationId: 'conv-d22-1', agentUserId: 'agent-d22-uuid', displayName: 'Codex 8' };
    broadcastDeviceSessionHostEvent(sessionpageAgentProvisionedEvent.name, event);
    await flush();
    expect(got).toEqual([event]);
  });
});

// Protocol 14 compatibility (delete with protocol14FileChanges on the next protocol bump): the frame a
// protocol-14 window receives for a turn with a file edit, captured at the host's egress.
describe('a protocol-14 window', () => {
  it('receives 14\'s own file entity for a patch, and a 15 window the patch unchanged', async () => {
    const host = new FrameSessionHost();
    const patch = { type: 'diff', changes: [{ operation: 'modify', path: '/w/a.txt' }], scope: 'file',
      patch: { format: 'git_patch', text: 'diff --git "a//w/a.txt" "b//w/a.txt"\n--- "a//w/a.txt"\n+++ "b//w/a.txt"\n@@ -2,3 +2,4 @@\n beta\n-gamma\n+GAMMA-817\n delta\n+zeta\n' } };
    const item = { kind: 'patch-tool-call', id: 't:tool:edit', seq: 1, toolCallId: 'edit', title: 'Edit a.txt', status: 'done', contentBlocks: [patch] };
    host.ipcMain.handle('sessionTimeline.sessionSnapshot', () => ({ turns: [{ id: 't', items: [item] }] }));
    const read = async (peerProtocol: number) => {
      const frames: unknown[] = [];
      let deliver: ((frame: string | Uint8Array) => void) | null = null;
      host.attach({ send: (frame) => frames.push(decodeHostWsMessage(frame)), close: () => {}, onFrame: (cb) => (deliver = cb), onClose: () => {} },
        { peerProtocol });
      deliver!(encodeHostWsMessage({ t: 'invoke', id: 1, channel: 'sessionTimeline.sessionSnapshot', args: [] }) as string);
      await flush();
      return (frames.find((frame) => (frame as { t: string }).t === 'result') as { value: { turns: Array<{ items: unknown[] }> } }).value.turns[0]!.items;
    };
    expect(await read(14)).toEqual([{ kind: 'modify-file-tool-call', id: 't:tool:edit', seq: 1, toolCallId: 'edit', title: 'Edit a.txt',
      status: 'done', path: '/w/a.txt', oldText: 'beta\ngamma\ndelta', newText: 'beta\nGAMMA-817\ndelta\nzeta' }]);
    expect(await read(15)).toEqual([item]);
  });
});
