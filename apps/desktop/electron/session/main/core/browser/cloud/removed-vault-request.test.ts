import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { desktopProtocolOutsideWindow } from '@gugu/core/cloud/serverDesktopVersions';
import { removedVaultRequest } from './removed-vault-request';
import { CloudBrowserLiveServer } from './live-server';
import type { CloudBrowser } from './cloud-browser';

vi.mock('./cloud-browser', () => ({ cloudBrowser: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

let live: CloudBrowserLiveServer | null = null;
let socket: WebSocket | null = null;
afterEach(() => { socket?.close(); live?.close(); socket = null; live = null; });

it('only recognizes the legacy request ID and discards credential fields', () => {
  expect(removedVaultRequest(JSON.stringify({ type: 'vault_submit', requestId: 'old-13', username: 'discard', password: 'discard', save: true }))).toEqual({ requestId: 'old-13' });
  expect(removedVaultRequest('not json')).toBeNull();
  expect(removedVaultRequest(JSON.stringify({ type: 'vault_submit', requestId: '../../bad' }))).toBeNull();
  expect(removedVaultRequest(JSON.stringify({ type: 'control_acquire' }))).toBeNull();
});

it('keeps a protocol-13 client connected, refuses the removed form immediately, and still grants takeover', async () => {
  expect(desktopProtocolOutsideWindow(13)).toBe(false);
  let holder: string | null = null;
  let changed = () => {};
  const browser = {
    onChange: (listener: () => void) => { changed = listener; },
    hub: () => null,
    status: () => ({ running: false, tabs: [], activeTabId: null, automation: 'idle', completed: false }),
    controlFor: (id: string) => holder === id ? 'granted' : 'released',
    acquireControl: (id: string) => { holder = id; changed(); },
    releaseControl: async () => { holder = null; },
    isHolder: (id: string) => holder === id,
  };
  live = new CloudBrowserLiveServer(browser as unknown as CloudBrowser);
  const { port, token } = await live.ensure();
  const messages: Array<Record<string, unknown>> = [];
  socket = new WebSocket(`ws://127.0.0.1:${port}/live`, ['gugu-browser-v1', `gugu-browser-ticket.${token}`]);
  socket.on('message', raw => messages.push(JSON.parse(String(raw))));
  await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });
  socket.send(JSON.stringify({ type: 'vault_submit', requestId: 'old-13', username: 'discard', password: 'discard', save: true }));
  await vi.waitFor(() => expect(messages.find(m => m.type === 'vault_result')).toMatchObject({
    requestId: 'old-13', ok: false, reason: 'gone', code: 'feature_removed', message: expect.stringContaining('Update Gugu'),
  }), { timeout: 2_000 });
  expect(messages.find(m => m.type === 'vault_result')).not.toHaveProperty('password');
  socket.send(JSON.stringify({ type: 'control_acquire' }));
  await vi.waitFor(() => expect(messages.some(m => m.type === 'state' && m.control === 'granted')).toBe(true));
});
