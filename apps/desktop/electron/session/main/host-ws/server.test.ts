// 真连接:node 内起 WebSocket 宿主,用浏览器侧客户端(src/lib/session-host-ws-client.ts)连上,
// 走完 preload 五个方法里过网的四个。浏览器全局(window / localStorage / history)用最小桩,
// WebSocket 与 MessageChannel 用 node 自带的。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionHostWsClient } from '@/lib/session-host-ws-client';
import { startSessionHostWsServer, type SessionHostWsServer } from './server';

type Posted = { data: unknown; ports: MessagePort[] };

function installBrowserShims(): Posted[] {
  const posted: Posted[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    location: { hash: '', pathname: '/', search: '' },
    postMessage: (data: unknown, _origin: string, transfer?: unknown[]) =>
      void posted.push({ data, ports: (transfer ?? []) as MessagePort[] }),
  };
  g.localStorage = { getItem: () => null, setItem: () => {} };
  g.history = { replaceState: () => {} };
  return posted;
}

async function loadClient() {
  return import('@/lib/session-host-ws-client');
}

/**
 * 回调驱动的等待:每个回调(状态变化、事件、消息、端口关闭)里 `notify()` 一下,`when(条件)` 就在那之后重判,
 * 成立即 resolve(已成立就立刻)。等的是回调送来的事实 ❌ 3 s 墙钟上限。
 */
function facts() {
  const waiters = new Set<{ holds: () => boolean; resolve: () => void }>();
  return {
    notify(): void {
      for (const waiter of waiters) {
        if (!waiter.holds()) continue;
        waiters.delete(waiter);
        waiter.resolve();
      }
    },
    when(holds: () => boolean): Promise<void> {
      return new Promise((resolve) => {
        if (holds()) resolve();
        else waiters.add({ holds, resolve });
      });
    },
  };
}

describe('task host WebSocket transport (server ↔ browser client)', () => {
  let server: SessionHostWsServer;
  let client: SessionHostWsClient | null = null;
  let posted: Posted[];

  beforeEach(async () => {
    posted = installBrowserShims();
    server = await startSessionHostWsServer({ port: 0 });
  });

  afterEach(async () => {
    client?.close();
    client = null;
    await server.close();
  });

  async function connectedClient(token = server.token) {
    const { createSessionHostWsClient } = await loadClient();
    client = createSessionHostWsClient({ url: `ws://127.0.0.1:${server.port}/`, token });
    return client;
  }

  it('rejects a wrong token and accepts the right one (paired control)', async () => {
    const bad = await connectedClient('not-the-token');
    await expect(bad.connect()).rejects.toThrow(/Cannot reach the task host/);
    bad.close();
    const good = await connectedClient();
    await expect(good.connect()).resolves.toBeUndefined();
    expect(good.state()).toBe('open');
  });

  it('invoke: result, thrown error (name kept), and unknown channel', async () => {
    server.hostIpc.ipcMain.handle('math.add', (_event, a, b) => (a as number) + (b as number));
    server.hostIpc.ipcMain.handle('math.boom', () => {
      throw new RangeError('boom');
    });
    const c = await connectedClient();
    await expect(c.api.invoke('math.add', 2, 3)).resolves.toBe(5);
    await expect(c.api.invoke('math.boom')).rejects.toMatchObject({ name: 'RangeError', message: 'boom' });
    await expect(c.api.invoke('math.nope')).rejects.toThrow(/No handler registered for 'math.nope'/);
  });

  // 网页版粘贴图片走 `pty.persistDroppedBlob({ bytes: Uint8Array })`:裸 JSON 会把字节写成
  // {"0":…} 对象,宿主端读不到 byteLength → 粘贴静默失败。两个方向都要保真。
  it('invoke carries Uint8Array arguments and results byte-for-byte', async () => {
    const seen: unknown[] = [];
    server.hostIpc.ipcMain.handle('bytes.echo', (_event, payload) => {
      seen.push(payload);
      const { bytes } = payload as { bytes: Uint8Array };
      return { bytes: new Uint8Array(bytes.map((b) => b ^ 0xff)), length: bytes.byteLength };
    });
    const c = await connectedClient();
    const input = new Uint8Array(70_000);
    for (let i = 0; i < input.length; i += 1) input[i] = (i * 31) & 0xff;
    const out = (await c.api.invoke('bytes.echo', { bytes: input, name: 'shot.png' })) as {
      bytes: Uint8Array;
      length: number;
    };
    expect((seen[0] as { bytes: unknown }).bytes).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(70_000);
    expect(out.bytes).toBeInstanceOf(Uint8Array);
    expect(out.bytes[12345]).toBe(input[12345]! ^ 0xff);
    expect(out.bytes.byteLength).toBe(70_000);
  });

  // 跨境 NAT 会把空闲连接悄悄掐死(owner 公网直连验收时页面反复「断开/重连」):宿主要主动
  // 心跳,浏览器要有看门狗。两条各用一个短周期的独立服务器验。
  it('host heartbeats with ws ping + hb frames and terminates a peer that never pongs', async () => {
    const hb = await startSessionHostWsServer({ port: 0, heartbeatMs: 40 });
    try {
      const { WebSocket: NodeWs } = await import('ws');
      const raw = new NodeWs(hb.url, { autoPong: false });
      const seen: string[] = [];
      let pings = 0;
      raw.on('ping', () => void (pings += 1));
      raw.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) seen.push(String(data));
      });
      const closed = new Promise<number>((resolve) => raw.on('close', (code: number) => resolve(code)));
      await new Promise<void>((resolve) => raw.on('open', () => resolve()));
      const code = await closed;
      expect(seen.some((frame) => frame === JSON.stringify({ t: 'hb' }))).toBe(true);
      expect(pings).toBeGreaterThanOrEqual(1);
      // 不回 pong 的对端被宿主 terminate:ws 以 1006 收尾。
      expect(code).toBe(1006);
    } finally {
      await hb.close();
    }
  });

  it('browser client closes a silent connection itself and reconnects', async () => {
    // 宿主心跳拉长到远超看门狗,模拟"线死了、什么都收不到"。
    const quiet = await startSessionHostWsServer({ port: 0, heartbeatMs: 10_000 });
    try {
      const { createSessionHostWsClient } = await loadClient();
      const c = createSessionHostWsClient({ url: `ws://127.0.0.1:${quiet.port}/`, token: quiet.token }, { staleMs: 120 });
      const states: string[] = [];
      const seen = facts();
      c.onStateChange((s) => {
        states.push(s);
        seen.notify();
      });
      await c.connect();
      await seen.when(() => states.includes('closed'));
      await seen.when(() => states.length >= 3 && states[states.length - 1] === 'open');
      expect(states).toEqual(expect.arrayContaining(['open', 'closed', 'connecting', 'open']));
      c.close();
    } finally {
      await quiet.close();
    }
  });

  it('events flow both ways; the WS sender id does not collide with webContents ids', async () => {
    const received: Array<[number, unknown]> = [];
    const arrived = facts();
    server.hostIpc.ipcMain.on('renderer.ping', (event, data) => {
      received.push([event.sender.id, data]);
      arrived.notify();
    });
    const c = await connectedClient();
    await c.connect();
    const got: unknown[] = [];
    c.api.eventOn('agents.changed', (data) => {
      got.push(data);
      arrived.notify();
    });
    server.hostIpc.broadcast('agents.changed', { n: 2 });
    await arrived.when(() => got.length > 0);
    expect(got).toEqual([{ n: 2 }]);
    c.api.eventSend('renderer.ping', { hello: true });
    await arrived.when(() => received.length > 0);
    expect(received[0][1]).toEqual({ hello: true });
    expect(received[0][0]).toBeGreaterThanOrEqual(1_000_000);
  });

  it('requestWirePort hands the page a live MessagePort that pumps JSON and binary both ways', async () => {
    const hostSeen: unknown[] = [];
    let hostPortClosed = false;
    const arrived = facts();
    server.hostIpc.ipcMain.handle('echo:connect', (event) => {
      const { port1, port2 } = server.hostIpc.createMessageChannel(event);
      port1.on('message', (...args: unknown[]) => {
        const data = (args[0] as { data: unknown }).data;
        hostSeen.push(data);
        port1.postMessage({ echo: data });
      });
      port1.on('close', () => {
        hostPortClosed = true;
        arrived.notify();
      });
      port1.start?.();
      event.sender.postMessage('echo:port', null, [port2]);
    });
    const c = await connectedClient();
    await c.api.requestWirePort('echo');
    expect(posted).toHaveLength(1);
    expect(posted[0].data).toEqual({ kind: 'echo:port' });
    const pagePort = posted[0].ports[0];
    expect(pagePort).toBeInstanceOf(MessagePort);

    const pageSeen: unknown[] = [];
    pagePort.onmessage = (ev) => {
      pageSeen.push(ev.data);
      arrived.notify();
    };
    pagePort.postMessage({ hi: 1 });
    await arrived.when(() => pageSeen.length > 0);
    expect(hostSeen[0]).toEqual({ hi: 1 });
    expect(pageSeen[0]).toEqual({ echo: { hi: 1 } });

    const bytes = new Uint8Array([9, 8, 7]);
    pagePort.postMessage({ kind: 'blob-chunk', channel: 'f', seq: 1, data: bytes });
    await arrived.when(() => pageSeen.length > 1);
    const hostChunk = hostSeen[1] as { data: Uint8Array };
    expect(hostChunk.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(hostChunk.data)).toEqual([9, 8, 7]);
    // 回程:宿主把 chunk 包在 {echo} 里,不再是顶层 blob-chunk → 走 JSON,Uint8Array 会变成普通对象;
    // 这里只断言路由通了。真 wire 的 blob 只在顶层出现,由上一段覆盖。
    expect(pageSeen[1]).toMatchObject({ echo: { kind: 'blob-chunk', seq: 1 } });

    // 连接断开 → 宿主那一侧的端口收到 close(hub 据此收会话)。
    c.close();
    await arrived.when(() => hostPortClosed);
    expect(hostPortClosed).toBe(true);
  });
});
