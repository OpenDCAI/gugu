import { describe, expect, it, vi } from 'vitest';
import { APP_FRAME_MARKER } from '@shared/extensions/app-runtime-protocol';

// Chats are named by their id (编号 18: placeOf refuses anything else).
const CHAT = '0c4a7e10-0000-4000-8000-000000000001';

/**
 * F16: an App's MCP program gets the same `gugu` as its pages, over the IPC channel main opened for it —
 * requests and answers as the phone's frame does, file sync traffic as `{ t: 'sync' }` on the same channel.
 * A fake channel, never the test process's own: vitest's workers talk to their runner over `process.send`.
 */
async function program() {
  const { startProgramGugu } = await import('./program-host');
  const sent: { t?: string; id?: number; method?: string }[] = [];
  const listeners: ((message: unknown) => void)[] = [];
  const gugu = startProgramGugu({
    send: (message: unknown) => {
      sent.push(message as { t?: string });
      return true;
    },
    on: (_event: 'message', listener: (message: unknown) => void) => listeners.push(listener),
  }) as Record<string, unknown> & { files: Record<string, (...args: unknown[]) => Promise<unknown>> };
  const deliver = (message: unknown) => listeners.forEach((listener) => listener(message));
  /** The next call the program sent, once it has (a files verb loads its module first). */
  const nextCall = async (after: number) => {
    for (let i = 0; i < 50; i += 1) {
      const call = sent.slice(after).find((message) => message.t === 'call');
      if (call) return call as { id: number; method: string };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('no call was sent');
  };
  return { gugu, sent, deliver, nextCall };
}

describe('gugu in a program', () => {
  it('page protocol events never inherit another active call; maintenance carries only its resource identity', async () => {
    const { gugu, sent, deliver, nextCall } = await program();
    const { programCall } = await import('./program-call');
    type Lease = { onMessage(fn: () => void): void; onPresentation(fn: () => void): void; presentation(): Promise<unknown>;
      maintain(method: string): Promise<unknown>; send(method: string): Promise<unknown> };
    const api = gugu.pages as { acquire(): Promise<Lease> };
    const opening = programCall.run('acquire-a', () => api.acquire());
    const request = await nextCall(0);
    const watchId = (request as unknown as { args: { watchId: string } }).args.watchId;
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: request.id, ok: true, value: { id: 'page-a', title: 'A', url: 'https://example.test' } });
    const lease = await opening;
    let maintenance: Promise<unknown> | undefined, operation: Promise<unknown> | undefined;
    lease.onMessage(() => { maintenance = lease.maintain('Runtime.enable'); operation = lease.send('Runtime.evaluate'); });
    const before = sent.length;
    programCall.run('unrelated-b', () => deliver({ m: APP_FRAME_MARKER, t: 'event',
      event: { type: 'taskPage', event: { type: 'message', watchId, method: 'Target.attachedToTarget', params: {} } } }));
    const maintain = await nextCall(before);
    expect(maintain).toMatchObject({ method: 'taskPageMaintain', args: { id: 'page-a' } });
    expect(maintain).not.toHaveProperty('call');
    const send = sent.slice(before).find(message => message.method === 'taskPageSend')!;
    expect(send).not.toHaveProperty('call');
    const denied = expect(operation).rejects.toThrow('current task call');
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: maintain.id, ok: true, value: {} });
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: send.id, ok: false, code: 'denied', message: 'A current task call is required' });
    await maintenance; await denied;
    let geometry: Promise<unknown> | undefined;
    lease.onPresentation(() => { geometry = lease.presentation(); });
    const geometryStart = sent.length;
    programCall.run('unrelated-b', () => deliver({ m: APP_FRAME_MARKER, t: 'event',
      event: { type: 'taskPage', event: { type: 'presentation', watchId, presentation: null } } }));
    const measure = await nextCall(geometryStart);
    expect(measure).toMatchObject({ method: 'taskPagePresentation', args: { id: 'page-a' } });
    expect(measure).not.toHaveProperty('call');
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: measure.id, ok: true, value: null }); await geometry;
  });
  it('custom MCP adapters enter their own stamped call without leaking it to another invocation', async () => {
    const { gugu, sent, deliver, nextCall } = await program();
    const withCall = gugu.withCall as <T>(meta: Record<string, unknown> | undefined, work: () => T) => T;
    expect(() => withCall(undefined, () => {})).toThrow('metadata');
    const first = withCall({ 'gugu/call': 'custom-a', 'gugu/sessionId': 'untrusted-selection' }, async () => {
      await Promise.resolve(); return gugu.files.list({ chat: CHAT });
    });
    const a = await nextCall(0);
    expect(a).toMatchObject({ call: 'custom-a', method: 'filesList' });
    const before = sent.length;
    const second = withCall({ 'gugu/call': 'custom-b' }, () => gugu.files.list({ chat: CHAT }));
    const b = await nextCall(before);
    expect(b).toMatchObject({ call: 'custom-b', method: 'filesList' });
    for (const call of [a, b]) deliver({ m: APP_FRAME_MARKER, t: 'result', id: call.id, ok: true, value: [] });
    await first; await second;
    const after = sent.length, outside = gugu.files.list({ chat: CHAT });
    const c = await nextCall(after); expect(c).not.toHaveProperty('call');
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: c.id, ok: true, value: [] }); await outside;
  });
  it('is the same gugu — files and the host verbs — without a page’s editor', async () => {
    const { gugu } = await program();
    expect(typeof gugu.files.open).toBe('function');
    expect(typeof gugu.files.list).toBe('function');
    expect(gugu.codemirror).toBeUndefined();
    expect(gugu.bind).toBeUndefined();
    expect(gugu.program).toBeUndefined(); // a host flag, not part of the API
    expect(gugu.onProjection).toBeUndefined();
    expect(gugu.onProjectionSource).toBeUndefined();
  });

  it('asks main over its channel, and main’s answer settles the call', async () => {
    const { gugu, sent, deliver, nextCall } = await program();
    const listing = gugu.files.list({ chat: CHAT });
    const call = await nextCall(sent.length);
    expect(call).toMatchObject({ m: APP_FRAME_MARKER, method: 'filesList', args: { place: { chat: CHAT } } });
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: call.id, ok: true, value: [{ id: 'item-1', name: 'a.md' }] });
    await expect(listing).resolves.toEqual([{ id: 'item-1', name: 'a.md' }]);
  });
  it('stamps file-payload requests with their exact live tool call and own page lease', async () => {
    const { gugu, sent, deliver, nextCall } = await program();
    const { programCall } = await import('./program-call');
    const pages = gugu.pages as { acquire(): Promise<{ filePayloads(refs: unknown[]): Promise<unknown> }> };
    const acquiring = programCall.run('upload-owner', () => pages.acquire());
    const open = await nextCall(0);
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: open.id, ok: true, value: { id: 'own-page', title: '', url: '' } });
    const lease = await acquiring, start = sent.length;
    const payload = programCall.run('upload-b', () => lease.filePayloads([{ file: 'card' }]));
    const request = await nextCall(start);
    expect(request).toMatchObject({ method: 'taskPageFilePayloads', call: 'upload-b', args: { id: 'own-page', refs: [{ file: 'card' }] } });
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: request.id, ok: true, value: [] });
    await expect(payload).resolves.toEqual([]);
  });

  it('surface buttons update their owned display outside another active tool caller', async () => {
    const { gugu, sent, deliver, nextCall } = await program();
    const { programCall } = await import('./program-call');
    const surfaces = gugu.surfaces as { open(options: unknown): Promise<{ id: string; onEvent(fn: () => void): void; update(value: unknown): Promise<void> }> };
    const opening = programCall.run('surface-owner', () => surfaces.open({ entry: 'bar.html', bounds: { x: 0, y: 0, width: 200, height: 30 } }));
    const request = await nextCall(0);
    expect(request).toMatchObject({ method: 'appSurfaceOpen', call: 'surface-owner' });
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: request.id, ok: true, value: { id: 'owned-display', shown: false } });
    const surface = await opening;
    let updated: Promise<void> | undefined;
    surface.onEvent(() => { updated = surface.update({ data: { paused: true } }); });
    const before = sent.length;
    programCall.run('another-task', () => deliver({ m: APP_FRAME_MARKER, t: 'event',
      event: { type: 'appSurface', event: { id: surface.id, type: 'message', message: { action: 'app-defined' } } } }));
    const update = await nextCall(before);
    expect(update).toMatchObject({ method: 'appSurfaceUpdate' }); expect(update).not.toHaveProperty('call');
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: update.id, ok: true }); await updated;
  });

  it('exposes projection sources and keeps later capture outside the finished calling agent scope', async () => {
    const { gugu, sent, deliver, nextCall } = await program();
    const { programCall } = await import('./program-call');
    const api = gugu.projection as { create(driver: { input(): Promise<void>; disconnect(): Promise<void>; refresh(): void; close(): void }): Promise<{
      id: string; publish(frame: unknown): Promise<number>;
    }> };
    let published: Promise<number> | undefined;
    const created = programCall.run('projection-tool-call', () => api.create({ input: async () => {}, disconnect: async () => {},
      refresh: () => { published = source.publish({ width: 1, height: 1, mime: 'image/png', data: 'YQ==' }); }, close() {},
    }));
    const creation = await nextCall(0);
    expect(creation).toMatchObject({ method: 'projectionCreate', call: 'projection-tool-call' });
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: creation.id, ok: true, value: { id: 'projection-resource' } });
    const source = await created;
    const before = sent.length;
    let control!: Promise<unknown>;
    programCall.run('unrelated-active-call', () => {
      deliver({ m: APP_FRAME_MARKER, t: 'event', event: { type: 'projectionSource', event: { type: 'refresh', id: source.id } } });
      control = gugu.files.list({ chat: CHAT });
    });
    // Positive control: ordinary verbs still carry the surrounding call, but a
    // host-owned capture callback must explicitly leave that caller's scope.
    await vi.waitFor(() => expect(sent.slice(before).some(message => message.method === 'projectionPublish')).toBe(true));
    const ordinary = sent.slice(before).find(message => message.method === 'filesList')!;
    expect(ordinary).toMatchObject({ call: 'unrelated-active-call' });
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: ordinary.id, ok: true, value: [] });
    await control;
    const publication = sent.slice(before).find(message => message.method === 'projectionPublish')!;
    expect(publication).toMatchObject({ method: 'projectionPublish', args: { id: 'projection-resource', frame: { sequence: 1 } } });
    expect(publication).not.toHaveProperty('call');
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: publication.id, ok: true });
    await expect(published).resolves.toBe(1);
  });

  it('keeps file sync frames apart from calls: a sync frame is never taken for an answer', async () => {
    const { gugu, sent, deliver, nextCall } = await program();
    const before = sent.length;
    const listing = gugu.files.list({ chat: CHAT });
    const call = await nextCall(before);
    deliver({ m: APP_FRAME_MARKER, t: 'sync', data: { t: 'up' } });
    // Control: still waiting after a sync frame; the answer settles it.
    await expect(Promise.race([listing, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 20))])).resolves.toBe('still waiting');
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: call.id, ok: false, code: 'denied', message: 'no' });
    await expect(listing).rejects.toMatchObject({ code: 'denied' });
  });

  // play4 10-13: Codex's edit, 42 ms after Claude's read of the same deck, was saved as Claude's — main had to guess which
  // call a verb was for. Now the verb says it: the tool call it was made in (program-call.ts), or none.
  it('a verb made inside a tool call says which call it is; one made outside every call says none', async () => {
    const { gugu, sent, deliver, nextCall } = await program();
    const { programCall } = await import('./program-call');
    const before = sent.length;
    const inCall = programCall.run('call-7', () => gugu.files.list({ chat: CHAT }));
    const first = await nextCall(before);
    expect(first).toMatchObject({ m: APP_FRAME_MARKER, method: 'filesList', call: 'call-7' });
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: first.id, ok: true, value: [] });
    await inCall;
    const after = sent.length;
    const outside = gugu.files.list({ chat: CHAT });
    const second = await nextCall(after);
    expect(second).not.toHaveProperty('call');
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: second.id, ok: true, value: [] });
    await outside;
  });
});
