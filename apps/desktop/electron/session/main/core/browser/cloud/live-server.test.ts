import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/gugu-cloud-browser-test' }, safeStorage: {} }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: { on: vi.fn() } }));
vi.mock('@main/core/extensions/extension-agent-context', () => ({ agentSessionContext: vi.fn(async () => null) }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { isQuietTunnelPort, resetTunnelActivityForTest, tunnelActiveAt } from '@gugu/core/cloud/remoteTunnel';
import { CloudBrowser } from './cloud-browser';
import { CloudBrowserLiveServer } from './live-server';

/**
 * #7199 云浏览器算不算「在用」(远程隧道据此判断云电脑别睡):实时画面的端口登记成安静端口,
 * 只看画面(config / ack / keepalive)不算,接管后的输入与人做的决定才算。不碰 Chrome。
 */
describe('#7199 cloud browser live server · tunnel activity', () => {
  let live: CloudBrowserLiveServer | null = null;
  let socket: WebSocket | null = null;

  afterEach(() => {
    socket?.close();
    live?.close();
    socket = null;
    live = null;
  });

  async function connect() {
    live = new CloudBrowserLiveServer(new CloudBrowser({ PATH: '' }, '/tmp/gugu-cloud-browser-test'));
    const { port, token } = await live.ensure();
    const messages: Array<Record<string, unknown>> = [];
    socket = new WebSocket(`ws://127.0.0.1:${port}/live`, ['gugu-browser-v1', `gugu-browser-ticket.${token}`]);
    socket.on('message', (data) => messages.push(JSON.parse(String(data))));
    await new Promise((resolve, reject) => {
      socket!.once('open', resolve);
      socket!.once('error', reject);
    });
    return { port, messages };
  }

  /** 发一条,等服务端处理完(本机回环,不碰 Chrome,150ms 足够)。 */
  async function sendAndSettle(messages: Array<Record<string, unknown>>, message: Record<string, unknown>) {
    const before = messages.length;
    socket!.send(JSON.stringify(message));
    await new Promise((resolve) => setTimeout(resolve, 150));
    return messages.slice(before);
  }

  it('端口一开就登记成安静端口,关掉就撤', async () => {
    const { port } = await connect();
    expect(isQuietTunnelPort(port)).toBe(true);
    live!.close();
    live = null;
    expect(isQuietTunnelPort(port)).toBe(false);
  });

  it('只看画面不算;接管后的输入算', async () => {
    const { messages } = await connect();
    resetTunnelActivityForTest();
    await sendAndSettle(messages, { type: 'config', framesEnabled: true, maxFps: 10, maxWidth: 1280, maxHeight: 800, tabId: null });
    await sendAndSettle(messages, { type: 'ack', seq: 1 });
    await sendAndSettle(messages, { type: 'keepalive' });
    expect(tunnelActiveAt()).toBeNull();

    // 没接管就发输入:被拒,不算
    await sendAndSettle(messages, { type: 'input_mouse', eventType: 'mousePressed', x: 10, y: 10, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 });
    expect(tunnelActiveAt()).toBeNull();

    // 接管(人的决定)算;接管后的点击也算
    await sendAndSettle(messages, { type: 'control_acquire' });
    const acquiredAt = tunnelActiveAt();
    expect(acquiredAt).not.toBeNull();
    resetTunnelActivityForTest();
    await sendAndSettle(messages, { type: 'input_mouse', eventType: 'mousePressed', x: 10, y: 10, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 });
    expect(tunnelActiveAt()).not.toBeNull();
  });
});
