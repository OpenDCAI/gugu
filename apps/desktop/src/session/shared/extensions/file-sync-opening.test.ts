import { afterEach, expect, it, vi } from 'vitest';
import { encodeAuthFrame } from './app-runtime-protocol';
import { FileSyncRelay, type SocketEvents } from './file-sync-core';

function connection() {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'none' })}.${encode({ sub: 'person', exp: Date.now() / 1000 + 3600 })}.sig`;
  let arrived!: (events: SocketEvents) => void;
  const connected = new Promise<SocketEvents>((resolve) => { arrived = resolve; });
  const close = vi.fn();
  const connect = vi.fn((_url: string, _protocols: string[], events: SocketEvents) => {
    arrived(events);
    return { send: vi.fn(), close, ping: () => false, terminate: vi.fn() };
  });
  const relay = new FileSyncRelay({
    serviceUrl: () => 'wss://files.invalid', token: async () => token, connect,
    hasCapability: () => true, warn: vi.fn(),
  });
  return { relay, connected, connect, close };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('opens one shared connection before a guest exists and reuses it for its grant', async () => {
  vi.useFakeTimers();
  const c = connection();
  c.relay.ensureFor(null);
  c.relay.ensureFor(null);
  const events = await c.connected;
  events.open();
  const page = c.relay.attachPage(1, 'workspace', { post: vi.fn(), close: vi.fn() });
  c.relay.grant(page, { docName: 'item@0', itemId: 'item', access: 'rw', needs: null });
  c.relay.fromPage(page, encodeAuthFrame('item@0\0provider', '').slice().buffer);
  expect(c.connect).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(30_000);
  expect(c.close).not.toHaveBeenCalled();
  c.relay.pageGone(page.id);
  vi.advanceTimersByTime(30_000);
  expect(c.close).toHaveBeenCalledWith(1000, 'idle');
});

it('uses the existing idle deadline when opening is cancelled before any guest claims it', async () => {
  vi.useFakeTimers();
  const c = connection();
  c.relay.ensureFor(null);
  (await c.connected).open();
  vi.advanceTimersByTime(30_000);
  expect(c.close).toHaveBeenCalledWith(1000, 'idle');
});
