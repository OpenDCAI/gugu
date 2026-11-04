import { afterEach, expect, it, vi } from 'vitest';
import type { BridgeCaller } from './extension-bridge';
import { closeAppPageResources } from './app-page-resources';
import { ExtensionProjectionViewers } from './extension-projection-viewers';
import type { ProjectionViewerClient } from './projection-viewer-provider';

const page = (id = 340, app = 'app-a', session = 'task-a') => ({ kind: 'page', pageId: id, extensionId: app,
  binding: { workspace: `session:${session}` } }) as unknown as BridgeCaller;
const client = (): ProjectionViewerClient => ({ signal: new AbortController().signal,
  open: vi.fn(async () => ({ id: 'native-stream', offer: { type: 'offer' as const, sdp: 'offer bytes' } })),
  answer: vi.fn(async () => {}), sign: vi.fn(() => 'signed opaque packet'), close: vi.fn(async () => {}) });
afterEach(() => { closeAppPageResources(340); closeAppPageResources(341); });

it('uses the actual calling page and returns only an opaque viewer and SDP, never authority keys', async () => {
  const transport = client(), open = vi.fn(async () => transport);
  const views = new ExtensionProjectionViewers(() => {}, open, vi.fn()), from = page();
  const result = await views.acquire(from, 'owned-source');
  expect(open).toHaveBeenCalledWith(340);
  expect(result).toEqual({ id: expect.any(String), offer: { type: 'offer', sdp: 'offer bytes' } });
  expect(result.id).not.toBe('native-stream');
  await views.answer(from, { id: result.id, answer: { type: 'answer', sdp: 'answer bytes' } });
  expect(transport.answer).toHaveBeenCalledWith('native-stream', { type: 'answer', sdp: 'answer bytes' });
  expect(views.sign(from, { id: result.id, data: '{}' })).toBe('signed opaque packet');
  expect(transport.sign).toHaveBeenCalledWith('native-stream', '{}');
});
it('refuses another App, task page, or binding generation even with a copied opaque ID', async () => {
  const transport = client(), from = page();
  const views = new ExtensionProjectionViewers(() => {}, async () => transport, vi.fn());
  const lease = await views.acquire(from, 'source');
  for (const other of [page(341), page(340, 'other-app'), page(340, 'app-a', 'task-b'), page()]) {
    expect(() => views.sign(other, { id: lease.id, data: '{}' })).toThrow('not owned');
  }
  expect(transport.sign).not.toHaveBeenCalled();
});
it('closes a late authenticated client if the document binding ended during capture', async () => {
  const pending = Promise.withResolvers<ProjectionViewerClient>(), transport = client();
  const views = new ExtensionProjectionViewers(() => {}, () => pending.promise, vi.fn());
  const opening = views.acquire(page(), 'source');
  closeAppPageResources(340); pending.resolve(transport);
  await expect(opening).rejects.toThrow('changed');
  expect(transport.open).not.toHaveBeenCalled(); expect(transport.close).toHaveBeenCalledTimes(1);
});
it('closes in-flight negotiation and cannot return a live viewer after a page retarget', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<ProjectionViewerClient['open']>>>(), transport = client();
  vi.mocked(transport.open).mockImplementation(() => pending.promise);
  const views = new ExtensionProjectionViewers(() => {}, async () => transport, vi.fn());
  const opening = views.acquire(page(), 'source'); await Promise.resolve();
  closeAppPageResources(340);
  pending.resolve({ id: 'late-stream', offer: { type: 'offer', sdp: 'bytes' } });
  await expect(opening).rejects.toThrow('changed'); expect(transport.close).toHaveBeenCalledTimes(1);
});
it('checks current grants on every operation and never signs oversized control payloads', async () => {
  let granted = true;
  const transport = client(), from = page();
  const views = new ExtensionProjectionViewers(() => { if (!granted) throw new Error('revoked'); }, async () => transport, vi.fn());
  const lease = await views.acquire(from, 'source');
  expect(() => views.sign(from, { id: lease.id, data: 'x'.repeat(16385) })).toThrow('Invalid');
  granted = false; expect(() => views.sign(from, { id: lease.id, data: '{}' })).toThrow('revoked');
  expect(transport.sign).not.toHaveBeenCalled();
});
