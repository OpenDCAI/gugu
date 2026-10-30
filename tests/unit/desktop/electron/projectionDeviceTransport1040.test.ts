import { describe, expect, it, vi } from 'vitest';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import type { openCloudDeviceRpcPipe } from '../../../../apps/desktop/electron/device-rpc-requester';

const opening = vi.hoisted(() => vi.fn<typeof openCloudDeviceRpcPipe>());
vi.mock('../../../../apps/desktop/electron/device-rpc-requester', () => ({ openCloudDeviceRpcPipe: opening }));
const { openProjectionDevicePipe } = await import('../../../../apps/desktop/electron/projection-device-transport');
const makeClient = (accessToken: () => Promise<string | null>) => createGuguSupabaseClient({
  url: 'http://127.0.0.1:1', anonKey: 'fixture-only', accessToken,
});
const handlers = { onMessage() {}, onClosed() {} };

describe('projection-owned realtime clients with the actual SDK', () => {
  it('isolates identical topic names and disconnects only the closing page connection', async () => {
    const clients: ReturnType<typeof makeClient>[] = [], closed: ReturnType<typeof vi.fn>[] = [];
    const input = { auth: async () => ({ userId: 'owner', accessToken: 'fixture' }), createClient(token: () => Promise<string | null>) {
      const client = makeClient(token); clients.push(client); closed.push(vi.spyOn(client.realtime, 'disconnect')); return client;
    } };
    opening.mockImplementation(async () => ({ send: async () => {}, close() {} }));
    const one = await openProjectionDevicePipe(input, 'device', 'asker1', handlers);
    const two = await openProjectionDevicePipe(input, 'device', 'asker2', handlers);
    try {
      const a = clients[0]!.channel('same-topic'), b = clients[1]!.channel('same-topic');
      // Actual SDK behavior that makes sharing one client unsafe for independent pipes.
      expect(clients[0]!.channel('same-topic')).toBe(a); expect(a).not.toBe(b);
      one.close(); one.close(); expect(closed[0]).toHaveBeenCalledTimes(1); expect(closed[1]).not.toHaveBeenCalled();
      expect(clients[1]!.getChannels()).toContain(b);
    } finally { one.close(); two.close(); }
  });
  it('rejects a new owner on an existing client and releases a failed subscribe', async () => {
    let auth = { userId: 'owner', accessToken: 'fixture' }, token!: () => Promise<string | null>;
    const client = makeClient(async () => 'fixture'), disconnected = vi.spyOn(client.realtime, 'disconnect');
    const input = { auth: async () => auth, createClient(read: () => Promise<string | null>) { token = read; return client; } };
    opening.mockImplementationOnce(async options => {
      expect(await options.userId()).toBe('owner'); auth = { userId: 'another-owner', accessToken: 'other' };
      await expect(token()).rejects.toThrow(/account changed/); await expect(options.userId()).rejects.toThrow(/account changed/);
      throw new Error('Subscribe refused');
    });
    await expect(openProjectionDevicePipe(input, 'device', 'asker', handlers)).rejects.toThrow(/Subscribe refused/);
    expect(disconnected).toHaveBeenCalledTimes(1);
  });
  it('cancels pending auth without creating a client, and closes a late pipe after subscribe cancellation', async () => {
    const auth = Promise.withResolvers<{ userId: string; accessToken: string }>(), first = new AbortController();
    const createClient = vi.fn(makeClient);
    let authSettled = false;
    const pending = openProjectionDevicePipe({ auth: () => auth.promise, createClient }, 'device', 'asker', handlers, first.signal)
      .then(() => undefined, error => error);
    void pending.then(() => { authSettled = true; });
    first.abort(new Error('Page left during auth'));
    try {
      await new Promise(resolve => setImmediate(resolve)); expect(authSettled).toBe(true);
      expect((await pending).message).toMatch(/Page left/); expect(createClient).not.toHaveBeenCalled();
    } finally { auth.resolve({ userId: 'owner', accessToken: 'fixture' }); await pending; }
    const lateError = new Error('Late pipe close failed'), report = vi.fn();
    const client = makeClient(async () => 'fixture'), disconnected = vi.spyOn(client.realtime, 'disconnect'), close = vi.fn(() => { throw lateError; });
    const pipe = Promise.withResolvers<{ close(): void; send(): Promise<void> }>();
    opening.mockImplementationOnce(() => pipe.promise);
    const second = new AbortController();
    let subscribeSettled = false;
    const subscribing = openProjectionDevicePipe({ auth: async () => ({ userId: 'owner', accessToken: 'fixture' }), createClient: () => client, report },
      'device', 'asker', handlers, second.signal).then(() => undefined, error => error);
    void subscribing.then(() => { subscribeSettled = true; });
    try {
      await new Promise(resolve => setImmediate(resolve)); second.abort(new Error('Page left during subscribe'));
      await new Promise(resolve => setImmediate(resolve)); expect(subscribeSettled).toBe(true);
      expect((await subscribing).message).toMatch(/Page left/); expect(disconnected).toHaveBeenCalledTimes(1);
    } finally { pipe.resolve({ close, send: async () => {} }); await subscribing; }
    await new Promise(resolve => setImmediate(resolve));
    expect(close).toHaveBeenCalledTimes(1); expect(report).toHaveBeenCalledWith(lateError);
  });
});
