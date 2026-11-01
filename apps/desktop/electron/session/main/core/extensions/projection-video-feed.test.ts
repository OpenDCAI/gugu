import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeCaller } from './extension-bridge';
import { ExtensionProjections } from './extension-projections';
import { ProjectionMediaAccess } from './projection-media-access';
import { ProjectionViewer } from './projection-viewer';
import type { ProjectionPixelLease } from './projection-image';
import { projectionVideoFeed } from './projection-video-feed';
import { revokeExtensionProgramAccess } from './extension-program-access';
import type { MediaProcess } from '../../../../../native/projection-media/node/host.mjs';

const principal = { extensionId: 'projection-video-feed-test', sessionId: 'task-a' };
const context = { ownerId: 'owner-a', deviceId: 'viewer-a', appId: principal.extensionId,
  sessionId: principal.sessionId, pageId: '10', epoch: '0' };
const caller = () => ({ extensionId: principal.extensionId, kind: 'page', pageId: 10,
  binding: { workspace: `session:${principal.sessionId}` } }) as unknown as BridgeCaller;
const frame = { width: 128, height: 96, mime: 'image/png' as const, data: 'YQ==' };
const control = new AbortController().signal;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const pixelLease = () => ({ data: new Uint8Array(128 * 96 * 4), release: vi.fn() });
function setup(options: { input?: () => Promise<void>; disconnect?: () => Promise<void>; decode?: () => Promise<ProjectionPixelLease>; refresh?: boolean } = {}) {
  const authorize = vi.fn();
  const resources = new ExtensionProjections(authorize);
  const input = vi.fn(options.input ?? (async () => {}));
  const disconnect = vi.fn(options.disconnect ?? (async () => {}));
  const source = resources.open(principal, { input, disconnect, close() {}, refresh() {
    if (options.refresh !== false) source.publish({ ...frame, sequence: 1 });
  } });
  const page = caller();
  const access = new ProjectionMediaAccess(resources, () => 0).open(page, source.id);
  const decode = vi.fn(options.decode ?? (async () => pixelLease()));
  const closed = deferred();
  const sendControl = vi.fn(async (_data: string) => {});
  const publish = vi.fn(async (sequence: number, _data: Uint8Array) => ({ sequence, width: 128, height: 96, rtpTimestamp: sequence * 9000 }));
  const create = vi.fn(async (_size: { width: number; height: number }, _signal: AbortSignal,
    _onControl: (data: string) => void): Promise<MediaProcess> => ({
    offer: { type: 'offer' as const, sdp: 'fixture' }, closed: closed.promise,
    answer: async () => {}, publish, sendControl, close: async () => { closed.resolve(); },
  }));
  const feed = projectionVideoFeed(resources, access, context, () => decode, create);
  const finish = async () => { await feed.lease.disconnect(); feed.lease.release(); await source.close(); };
  const packet = (generation: string, type: 'input' | 'ack' = 'ack', sequence = 1, frame = 1) => JSON.stringify({ type, generation,
    frame, ...(type === 'input' ? { sequence, input: { kind: 'text', text: '一次中文' } } : {}) });
  return { feed, access, input, disconnect, create, decode, sendControl, publish, source, page, authorize, finish, packet };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); revokeExtensionProgramAccess(principal.extensionId); });

describe('actual projection resource → host encoder → correlated input', () => {
  it('does not encode until the direct connection answers, and waits for the real driver result', async () => {
    const gate = deferred(); const s = setup({ input: () => gate.promise });
    const media = await s.feed.openMedia(control, () => {});
    expect(s.publish).not.toHaveBeenCalled();
    await media.answer({ type: 'answer', sdp: 'fixture' }); await tick();
    expect(s.publish).toHaveBeenCalledExactlyOnceWith(1, expect.any(Uint8Array));
    const { generation } = JSON.parse(s.sendControl.mock.calls[0]![0]);
    await s.feed.lease.receive(s.packet(generation), control);
    let returned = false;
    const sending = s.feed.lease.receive(s.packet(generation, 'input'), control).then(result => { returned = true; return result; });
    await tick(); expect(s.input).toHaveBeenCalledTimes(1); expect(returned).toBe(false);
    gate.resolve();
    expect(JSON.parse((await sending)!)).toEqual({ type: 'input-result', generation, sequence: 1, status: 'applied' });
    await s.finish(); await media.close();
  });

  it('keeps only the newest replacement, and never accepts an unseen or superseded frame', async () => {
    const s = setup(); const media = await s.feed.openMedia(control, () => {});
    await expect(s.feed.lease.receive(s.packet('fake'), control)).rejects.toThrow(/not been encoded/);
    await media.answer({ type: 'answer', sdp: 'fixture' }); await tick();
    const { generation } = JSON.parse(s.sendControl.mock.calls[0]![0]);
    s.source.publish({ ...frame, sequence: 2 }); s.source.publish({ ...frame, sequence: 3 });
    expect(s.publish).toHaveBeenCalledTimes(1);
    await s.feed.lease.receive(s.packet(generation), control); await tick();
    expect(s.publish.mock.calls.map(args => args[0])).toEqual([1, 3]);
    await expect(s.feed.lease.receive(s.packet(generation, 'ack', 1, 2), control)).rejects.toThrow(/Stale projection frame/);
    await s.feed.lease.receive(s.packet(generation, 'ack', 1, 3), control);
    expect(JSON.parse((await s.feed.lease.receive(s.packet(generation, 'input', 1, 1), control))!).status).toBe('rejected');
    expect(s.input).not.toHaveBeenCalled();
    await s.finish(); await media.close();
  });

  it('coalesces concurrent recovery ACKs without acknowledging an unseen replacement', async () => {
    const s = setup(); const media = await s.feed.openMedia(control, () => {});
    await media.answer({ type: 'answer', sdp: 'fixture' }); await tick();
    const { generation } = JSON.parse(s.sendControl.mock.calls[0]![0]);
    s.source.publish({ ...frame, sequence: 2 });
    const ack = s.packet(generation);
    await Promise.all([s.feed.lease.receive(ack, control), s.feed.lease.receive(ack, control)]);
    await s.feed.lease.receive(ack, control);
    expect(JSON.parse((await s.feed.lease.receive(s.packet(generation, 'input', 1, 2), control))!).status).toBe('rejected');
    await expect(s.feed.lease.receive(s.packet('old-generation'), control)).rejects.toThrow(/Stale/);
    await s.feed.lease.receive(s.packet(generation, 'ack', 1, 2), control);
    await expect(s.feed.lease.receive(ack, control)).rejects.toThrow(/Stale/);
    await s.finish(); await media.close();
  });

  it('retries a failed ACK and still checks authority on an already acknowledged frame', async () => {
    const original = ProjectionViewer.prototype.ack;
    const ack = vi.spyOn(ProjectionViewer.prototype, 'ack').mockImplementationOnce(() => { throw new Error('ACK refused'); })
      .mockImplementation(original);
    const s = setup(); const media = await s.feed.openMedia(control, () => {});
    await media.answer({ type: 'answer', sdp: 'fixture' }); await tick();
    const { generation } = JSON.parse(s.sendControl.mock.calls[0]![0]);
    await expect(s.feed.lease.receive(s.packet(generation), control)).rejects.toThrow('ACK refused');
    await s.feed.lease.receive(s.packet(generation), control);
    expect(ack).toHaveBeenCalledTimes(2);
    await s.feed.lease.receive(s.packet(generation), control);
    expect(ack).toHaveBeenCalledTimes(2);
    s.page.binding!.workspace = 'session:task-b';
    await expect(s.feed.lease.receive(s.packet(generation), control)).rejects.toThrow(/binding changed/);
    await s.finish(); await media.close();
  });

  it('holds pixel storage through encoder completion and returns it on failure', async () => {
    const pixels = pixelLease(); const encoded = deferred<{ sequence: number; width: number; height: number; rtpTimestamp: number }>();
    const s = setup({ decode: async () => pixels }); const media = await s.feed.openMedia(control, () => {});
    s.publish.mockImplementation(() => encoded.promise);
    await media.answer({ type: 'answer', sdp: 'fixture' }); await tick();
    expect(s.publish.mock.calls[0]![1]).toBe(pixels.data);
    expect(pixels.release).not.toHaveBeenCalled();
    // Even cancellation cannot return borrowed storage before publish settles.
    s.feed.lease.release(); await tick();
    expect(pixels.release).not.toHaveBeenCalled();
    encoded.resolve({ sequence: 999, width: 128, height: 96, rtpTimestamp: 90 }); await tick();
    expect(pixels.release).toHaveBeenCalledExactlyOnceWith();
    await s.finish(); await media.close();
  });

  it('returns storage after a successful encode, an invalid receipt, or rejected publish', async () => {
    for (const mode of ['success', 'receipt', 'failure'] as const) {
      const pixels = pixelLease(); const s = setup({ decode: async () => pixels });
      const media = await s.feed.openMedia(control, () => {});
      if (mode === 'receipt') s.publish.mockImplementation(async () => ({ sequence: 999, width: 128, height: 96, rtpTimestamp: 90 }));
      if (mode === 'failure') s.publish.mockRejectedValue(new Error('Encoder failed'));
      await media.answer({ type: 'answer', sdp: 'fixture' }); await tick();
      expect(pixels.release).toHaveBeenCalledExactlyOnceWith();
      expect(s.feed.lease.signal.aborted).toBe(mode !== 'success');
      await s.finish(); await media.close();
    }
  });

  it('rechecks the real page/grant after an asynchronous decode and never publishes after retarget', async () => {
    const pixels = deferred<ProjectionPixelLease>(); const s = setup({ decode: () => pixels.promise });
    const media = await s.feed.openMedia(control, () => {});
    await media.answer({ type: 'answer', sdp: 'fixture' }); await tick();
    s.page.binding!.workspace = 'session:task-b';
    const lease = pixelLease(); pixels.resolve(lease); await tick();
    expect(lease.release).toHaveBeenCalledExactlyOnceWith();
    expect(s.publish).not.toHaveBeenCalled();
    expect(s.feed.lease.signal.aborted).toBe(true);
    await s.finish(); await media.close();
  });

  it('closes the viewer on geometry change instead of encoding new coordinates in an old stream', async () => {
    const s = setup(); const media = await s.feed.openMedia(control, () => {});
    await media.answer({ type: 'answer', sdp: 'fixture' }); await tick();
    const { generation } = JSON.parse(s.sendControl.mock.calls[0]![0]);
    s.source.publish({ ...frame, width: 256, sequence: 2 });
    await expect(s.feed.lease.receive(s.packet(generation), control)).rejects.toThrow(/geometry changed/); await tick();
    expect(s.feed.lease.signal.aborted).toBe(true);
    expect(s.publish).toHaveBeenCalledTimes(1);
    await s.finish(); await media.close();
  });

  it('aborts pending input immediately but waits for driver cleanup before releasing authority', async () => {
    const action = deferred(), cleanup = deferred();
    const s = setup({ input: () => action.promise, disconnect: () => cleanup.promise });
    const media = await s.feed.openMedia(control, () => {});
    await media.answer({ type: 'answer', sdp: 'fixture' }); await tick();
    const { generation } = JSON.parse(s.sendControl.mock.calls[0]![0]);
    await s.feed.lease.receive(s.packet(generation), control);
    const request = new AbortController();
    const sending = s.feed.lease.receive(s.packet(generation, 'input'), request.signal);
    const rejected = expect(sending).rejects.toThrow('viewer gone');
    await tick(); request.abort(new Error('viewer gone')); await rejected;
    let drained = false;
    const closing = s.feed.lease.disconnect().then(() => { drained = true; });
    action.resolve(); await tick(); expect(s.disconnect).toHaveBeenCalled(); expect(drained).toBe(false);
    cleanup.resolve(); await closing;
    s.feed.lease.release(); await s.source.close(); await media.close();
  });

  it('bounds a silent source and cancels without starting a helper', async () => {
    vi.useFakeTimers(); const s = setup({ refresh: false });
    const opening = s.feed.openMedia(control, () => {});
    const rejected = expect(opening).rejects.toThrow(/fresh frame/);
    await vi.advanceTimersByTimeAsync(10_000); await rejected;
    expect(s.create).not.toHaveBeenCalled(); await s.finish();
  });

  it('rejects a mismatched encoder receipt and preserves the source for another viewer', async () => {
    const s = setup(); const media = await s.feed.openMedia(control, () => {});
    s.publish.mockImplementation(async () => ({ sequence: 999, width: 128, height: 96, rtpTimestamp: 90 }));
    await media.answer({ type: 'answer', sdp: 'fixture' }); await tick();
    expect(s.feed.lease.signal.aborted).toBe(true);
    expect(s.access.signal.aborted).toBe(false);
    await s.finish(); await media.close();
  });

  it('stops a pending decoder when authority is released even before explicit disconnect', async () => {
    const pixels = deferred<ProjectionPixelLease>(); const s = setup({ decode: () => pixels.promise });
    const media = await s.feed.openMedia(control, () => {});
    await media.answer({ type: 'answer', sdp: 'fixture' }); await tick();
    s.feed.lease.release();
    expect(s.feed.lease.signal.aborted).toBe(true);
    const lease = pixelLease(); pixels.resolve(lease); await tick();
    expect(lease.release).toHaveBeenCalledExactlyOnceWith();
    expect(s.publish).not.toHaveBeenCalled();
    await s.finish(); await media.close();
  });
});
