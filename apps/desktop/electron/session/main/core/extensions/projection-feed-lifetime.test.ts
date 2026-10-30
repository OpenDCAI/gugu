import type { NativeImage } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { BridgeCaller } from './extension-bridge';
import type { MediaProcess } from '../../../../../native/projection-media/node/host.mjs';
import { ExtensionProjections } from './extension-projections';
import { ProjectionMediaAccess } from './projection-media-access';
import { createProjectionImageDecoder } from './projection-image';
import { projectionVideoFeed } from './projection-video-feed';

const principal = { extensionId: 'feed-lifetime', sessionId: 'task' };
const context = { ownerId: 'owner', deviceId: 'viewer', appId: principal.extensionId, sessionId: principal.sessionId, pageId: '1', epoch: '0' };
const frame = { width: 128, height: 96, mime: 'image/png' as const, data: 'YQ==' };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const image = (bytes: Buffer) => ({ isEmpty: () => false, getSize: () => ({ width: 128, height: 96 }),
  toBitmap: () => bytes.length > 1 ? Buffer.from([40, 100, 200, 255, 20, 50, 100, 128]) : Buffer.alloc(128 * 96 * 4, 255),
}) as unknown as NativeImage;
const decoder = () => createProjectionImageDecoder(image, { r: 0, g: 0, b: 0 });
function setup(createDecoder = decoder) {
  const resources = new ExtensionProjections(() => {});
  const source = resources.open(principal, { input: async () => {}, disconnect: async () => {}, close() {},
    refresh() { source.publish({ ...frame, sequence: 1 }); } });
  const page = { kind: 'page', extensionId: principal.extensionId, pageId: 1, binding: { sessionId: principal.sessionId } } as BridgeCaller;
  const authority = new ProjectionMediaAccess(resources, () => 0).open(page, source.id);
  const closed = deferred();
  const publish = vi.fn(async (sequence: number, _data: Uint8Array) => ({ sequence, width: 128, height: 96, rtpTimestamp: sequence * 9000 }));
  const media: MediaProcess = { offer: { type: 'offer', sdp: 'fixture' }, closed: closed.promise,
    answer: async () => {}, sendControl: vi.fn(async (_data: string) => {}), publish, close: vi.fn(async () => { closed.resolve(); }) };
  const create = vi.fn(async () => media);
  const feed = projectionVideoFeed(resources, authority, context, createDecoder, create);
  const finish = async () => { await feed.lease.disconnect(); feed.lease.release(); await source.close(); };
  return { feed, media, create, publish, source, finish };
}

describe('projection feed ownership', () => {
  it('joins late-created media after cancellation before rejecting initialization', async () => {
    const s = setup(), created = deferred(), closed = deferred();
    const cancellation = new AbortController(), reason = new Error('Viewer changed task');
    s.create.mockImplementation(async () => { await created.promise; return s.media; });
    vi.mocked(s.media.close).mockImplementation(async () => { await closed.promise; });
    let settled = false;
    const pending = s.feed.openMedia(cancellation.signal, () => {}).finally(() => { settled = true; });
    const rejected = expect(pending).rejects.toBe(reason);
    try {
      await tick(); expect(s.create).toHaveBeenCalledTimes(1);
      cancellation.abort(reason); created.resolve(); await tick();
      expect(s.media.close).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      closed.resolve(); await rejected;
    } finally { created.resolve(); closed.resolve(); await pending.catch(() => {}); await s.finish(); }
  });

  it('preserves the cancellation and a late helper cleanup failure together', async () => {
    const s = setup(), created = deferred(), cancellation = new AbortController();
    const reason = new Error('Viewer gone'), cleanup = new Error('Helper required SIGKILL');
    s.create.mockImplementation(async () => { await created.promise; return s.media; });
    vi.mocked(s.media.close).mockRejectedValue(cleanup);
    const pending = s.feed.openMedia(cancellation.signal, () => {});
    const rejected = expect(pending).rejects.toMatchObject({ message: expect.stringContaining(cleanup.message), cause: reason, errors: [reason, cleanup] });
    try { await tick(); cancellation.abort(reason); created.resolve(); await rejected; }
    finally { created.resolve(); await pending.catch(() => {}); await s.finish(); }
  });

  it('keeps two streams independent while both encoders still borrow pixels', async () => {
    const createDecoder = vi.fn(decoder), a = setup(createDecoder), b = setup(createDecoder);
    const encodedA = deferred<Awaited<ReturnType<MediaProcess['publish']>>>();
    const encodedB = deferred<Awaited<ReturnType<MediaProcess['publish']>>>();
    a.publish.mockImplementationOnce(() => encodedA.promise); b.publish.mockImplementationOnce(() => encodedB.promise);
    try {
      await (await a.feed.openMedia(new AbortController().signal, () => {})).answer({ type: 'answer', sdp: 'fixture' });
      await tick();
      await (await b.feed.openMedia(new AbortController().signal, () => {})).answer({ type: 'answer', sdp: 'fixture' });
      await tick();
      expect(b.feed.lease.signal.aborted, String(b.feed.lease.signal.reason)).toBe(false);
      expect(a.publish).toHaveBeenCalledTimes(1); expect(b.publish).toHaveBeenCalledTimes(1);
      expect(createDecoder).toHaveBeenCalledTimes(2);
      expect(a.publish.mock.calls[0]![1]).not.toBe(b.publish.mock.calls[0]![1]);
      const receipt = { sequence: 1, width: 128, height: 96, rtpTimestamp: 9000 };
      encodedA.resolve(receipt); encodedB.resolve(receipt); await tick();
      for (const stream of [a, b]) {
        const { generation } = JSON.parse(vi.mocked(stream.media.sendControl).mock.calls[0]![0]);
        await stream.feed.lease.receive(JSON.stringify({ type: 'ack', generation, frame: 1 }), new AbortController().signal);
        await stream.source.publish({ ...frame, sequence: 2 }); await tick();
        expect(stream.publish).toHaveBeenCalledTimes(2);
        expect(stream.publish.mock.calls[1]![1]).toBe(stream.publish.mock.calls[0]![1]);
      }
    } finally {
      const receipt = { sequence: 1, width: 128, height: 96, rtpTimestamp: 9000 };
      encodedA.resolve(receipt); encodedB.resolve(receipt); await tick();
      await a.media.close(); await b.media.close(); await a.finish(); await b.finish();
    }
  });
});
