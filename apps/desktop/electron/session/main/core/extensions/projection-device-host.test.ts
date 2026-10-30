import { describe, expect, it, vi } from 'vitest';
import type { DeviceRpcAskerContext, DeviceRpcHandlerContext } from '@gugu/core/cloud/deviceRpcResponder';
import { createProjectionHostIdentity } from '../../../../projection-host-identity';
import { projectionControlSigner } from '../../../../projection-control-auth';
import { createProjectionDeviceHost } from './projection-device-host';
import { ExtensionProjections } from './extension-projections';
import { ProjectionMediaAccess } from './projection-media-access';
import { projectionVideoFeed } from './projection-video-feed';
import { createProjectionDeviceClient } from '../../../../projection-device-client';
import { createDeviceRpcRequestHandler } from '@gugu/core/cloud/deviceRpcResponder';

const tick = () => new Promise(done => setImmediate(done));
function asker() {
  const listeners = new Set<() => void>();
  return { id: 'same-wire-id', onDetached(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    detach() { for (const fn of [...listeners]) fn(); } };
}
async function setup() {
  let allowed = true, version = '1';
  const identity = createProjectionHostIdentity({ auth: async () => ({ userId: 'real-owner', accessToken: 'fixture' }),
    runtime: () => ({ ownerId: 'real-owner', deviceId: 'real-device', runtimeInstanceId: 'real-runtime' }) });
  const resources = new ExtensionProjections(() => { if (!allowed) throw new Error('Capability revoked'); });
  const access = new ProjectionMediaAccess(resources, () => 0), input = vi.fn(async (_input: unknown) => {}), disconnect = vi.fn(async () => {});
  const source = resources.open({ extensionId: 'app', sessionId: 'task' }, { input, disconnect, close() {}, refresh() {
    source.publish({ sequence: 1, width: 128, height: 96, mime: 'image/png', data: 'YQ==' });
  } });
  let control: (data: string) => void = () => {}, generation = '';
  const closed = vi.fn(), reports = vi.fn(), create = vi.fn();
  const host = createProjectionDeviceHost({ identity, report: reports,
    assertApp(id, expected) { if (id !== 'app' || version !== expected || !allowed) throw new Error('App version/capability changed'); },
    createFeed(binding, id, context) {
      create(context);
      return projectionVideoFeed(resources, access.openRemote(binding, id), context,
        () => async () => ({ data: new Uint8Array(128 * 96 * 4), release() {} }), async (_size, _signal, onControl) => {
          control = onControl; let end!: () => void;
          return { offer: { type: 'offer', sdp: 'fixture' }, closed: new Promise<void>(done => { end = done; }),
            answer: async () => {}, publish: async sequence => ({ sequence, width: 128, height: 96, rtpTimestamp: 9000 }),
            sendControl: async raw => { const p = JSON.parse(raw); if (p.type === 'projection-generation') generation = p.generation; },
            close: async () => { closed(); end(); } };
        });
    },
  });
  const a = asker();
  const call = async (method: string, payload: unknown, from: DeviceRpcAskerContext | undefined = a) => {
    const response = await host.handlers[`projection.${method}`]!(payload, { asker: from } as DeviceRpcHandlerContext);
    return response.result as Record<string, string>;
  };
  const hello = await call('hello', {});
  const page = { id: 'actual-main-page', epoch: 1, appId: 'app', version: '1', sessionId: 'task' };
  const bind = () => call('bind', { proof: hello.proof, page });
  const binding = await bind();
  const signal = (command: unknown, credentials = binding) => call('signal', { proof: hello.proof, bindingId: credentials.bindingId, command });
  const open = () => signal({ type: 'open', sourceId: source.id, requestId: 'open' });
  const packet = (type: 'ack' | 'input') => JSON.stringify({ type, generation, frame: 1,
    ...(type === 'input' ? { sequence: 1, input: { kind: 'text', text: '实际中文' } } : {}) });
  return { host, identity, a, call, hello, page, binding, bind, signal, source, open, packet, reports, input, disconnect, closed, create,
    control: (raw: string) => control(raw), version: (v: string) => { version = v; }, revoke: () => { allowed = false; },
    sign: (raw: string) => projectionControlSigner(binding.controlKey!, binding.bindingId!, source.id, () => {})(raw),
    async finish() { await host.dispose(); identity.dispose(); await source.close(); } };
}
describe('real registered projection handlers and source authority', () => {
  it('checks private proof, actual connection, App version/task, and never reads payload identity', async () => {
    const s = await setup();
    try {
      await expect(s.call('hello', { ownerId: 'forged' })).rejects.toThrow(/Unexpected/);
      await expect(s.call('bind', { proof: s.hello.proof, page: s.page }, asker())).rejects.toThrow(/authentication/);
      await expect(s.call('bind', { proof: s.hello.proof, page: { ...s.page, epoch: 2, version: 'wrong' } })).rejects.toThrow(/version/);
      await s.open(); expect(s.create.mock.calls[0]![0]).toMatchObject({ ownerId: 'real-owner', deviceId: 'real-device', appId: 'app', sessionId: 'task' });
      s.version('2'); await expect(s.signal({ type: 'open', sourceId: s.source.id, requestId: 'second' })).rejects.toThrow(/version/);
    } finally { await s.finish(); }
  });
  it('admits signed ACK/input once through the actual registry and rejects bare controls', async () => {
    const s = await setup();
    try {
      const opened = await s.open(); await s.signal({ type: 'answer', id: opened.id, sdp: { type: 'answer', sdp: 'fixture' } }); await tick();
      s.control(s.sign(s.packet('ack'))); await tick(); s.control(s.sign(s.packet('input'))); await tick();
      expect(s.input).toHaveBeenCalledTimes(1); expect(s.input.mock.calls[0]![0]).toMatchObject({ kind: 'text', text: '实际中文' });
      s.control(JSON.stringify({ ...JSON.parse(s.packet('input')), sequence: 2 })); await tick(); expect(s.input).toHaveBeenCalledTimes(1);
      expect(s.reports).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/control envelope/) }));
    } finally { await s.finish(); }
  });
  it('advances page epoch before draining, rejects old handles and delayed old bind, and retains the source', async () => {
    const s = await setup();
    try {
      const opened = await s.open(); await s.signal({ type: 'answer', id: opened.id, sdp: { type: 'answer', sdp: 'fixture' } });
      s.page.epoch++; const next = await s.bind(); expect(next.bindingId).not.toBe(s.binding.bindingId);
      await expect(s.signal({ type: 'answer', id: opened.id, sdp: { type: 'answer', sdp: 'late' } })).rejects.toThrow(/another connection/);
      s.page.epoch--; await expect(s.bind()).rejects.toThrow(/Stale/);
      expect(s.closed).toHaveBeenCalledTimes(1); expect(s.source.isClosing()).toBe(false);
    } finally { await s.finish(); }
  });
  it('account change and actual asker detach immediately stop control and await physical cleanup', async () => {
    for (const mode of ['account', 'detach'] as const) {
      const s = await setup();
      try {
        const opened = await s.open(); await s.signal({ type: 'answer', id: opened.id, sdp: { type: 'answer', sdp: 'fixture' } });
        if (mode === 'account') s.identity.invalidate(); else s.a.detach();
        s.control(s.sign(s.packet('input'))); await tick();
        expect(s.input).not.toHaveBeenCalled(); await expect(s.open()).rejects.toThrow(/authentication/);
        await s.host.dispose(); expect(s.closed).toHaveBeenCalledTimes(1);
      } finally { await s.finish(); }
    }
  });

  it('the actual requester/responder signs only for its live host page and releases exactly once', async () => {
    const s = await setup(), pageAbort = new AbortController(), released = vi.fn(), wireAsker = asker();
    const respond = createDeviceRpcRequestHandler({ handlers: s.host.handlers });
    const requests: Array<{ type: string; payload: unknown }> = [], pipeClosed = vi.fn(() => wireAsker.detach());
    const client = await createProjectionDeviceClient({ identity: s.identity, report: s.reports,
      page: { id: 'host-stamped-page', epoch: 1, appId: 'app', version: '1', sessionId: 'task', deviceId: 'real-device',
        signal: pageAbort.signal, assertCurrent: () => pageAbort.signal.throwIfAborted(), release: released },
      openPipe: async (target, id, handlers) => {
        expect(target).toBe('real-device'); expect(id).toMatch(/^[0-9a-f]{32}$/);
        return { send: async raw => { const message = (raw as { payload: { type: string; payload: unknown } }).payload; requests.push(message);
          await respond(raw, reply => handlers.onMessage(reply), undefined, wireAsker); }, close: pipeClosed };
      },
    });
    try {
      const opened = await client.open(s.source.id);
      expect(Object.keys(opened).sort()).toEqual(['id', 'offer']); expect(Object.keys(client)).not.toContain('controlKey');
      await client.answer(opened.id, { type: 'answer', sdp: 'fixture' }); await tick();
      s.control(client.sign(opened.id, s.packet('ack'))); await tick();
      s.control(client.sign(opened.id, s.packet('input'))); await tick(); expect(s.input).toHaveBeenCalledTimes(1);
      pageAbort.abort(new Error('Host retargeted the page'));
      expect(() => client.sign(opened.id, s.packet('input'))).toThrow(/retargeted/);
      await client.close(); await client.close();
      expect(pipeClosed).toHaveBeenCalledTimes(1); expect(released).toHaveBeenCalledTimes(1); expect(s.closed).toHaveBeenCalledTimes(1);
      expect(requests.filter(request => request.type === 'projection.unbind')).toHaveLength(1);
    } finally { await client.close(); await s.finish(); }
  });

  it('cancels a page before a delayed bind and never gives another asker a cached proof', async () => {
    const s = await setup();
    try {
      await s.call('unbind', { proof: s.hello.proof, page: { id: 'late-page', epoch: 3 } });
      await expect(s.call('bind', { proof: s.hello.proof, page: { ...s.page, id: 'late-page', epoch: 3 } })).rejects.toThrow(/already cancelled/);
      const respond = createDeviceRpcRequestHandler({ handlers: s.host.handlers });
      const request = { type: 'projection.hello', request_id: 'same-request-id', user_id: 'claimed-user', payload: {} };
      let first: unknown, second: unknown;
      await respond(request, reply => { first = reply; }, undefined, s.a);
      await respond(request, reply => { second = reply; }, undefined, asker());
      expect(second).not.toEqual(first);
      expect(second).toMatchObject({ result: { proof: expect.any(String), deviceId: 'real-device' } });
    } finally { await s.finish(); }
  });

  it('goodbye releases proof and page tombstones before the physical asker eventually detaches', async () => {
    const s = await setup();
    try {
      let hello = s.hello;
      for (let index = 0; index < 130; index++) {
        await s.call('goodbye', { proof: hello.proof });
        await expect(s.call('bind', { proof: hello.proof, page: s.page })).rejects.toThrow(/authentication/);
        const next = await s.call('hello', {}); expect(next.proof).not.toBe(hello.proof); hello = next;
        await s.call('bind', { proof: hello.proof, page: { ...s.page, id: `page-${index}` } });
      }
    } finally { await s.finish(); }
  });

  it('dispose returns an in-flight driver cleanup failure after closing media and releasing proof', async () => {
    const s = await setup(), failure = new Error('Fixture driver disconnect failed');
    try {
      const opened = await s.open(); await s.signal({ type: 'answer', id: opened.id, sdp: { type: 'answer', sdp: 'fixture' } });
      s.disconnect.mockRejectedValueOnce(failure);
      const stopping = s.host.dispose(); expect(s.host.dispose()).toBe(stopping);
      await expect(stopping).rejects.toBe(failure);
      await expect(s.host.dispose()).rejects.toBe(failure);
      expect(s.closed).toHaveBeenCalledTimes(1); expect(s.reports).toHaveBeenCalledWith(failure);
      await expect(s.call('hello', {})).rejects.toThrow(/authentication/);
    } finally {
      await s.host.dispose().catch(() => {}); s.identity.dispose(); await s.source.close().catch(() => {});
    }
  });
});
