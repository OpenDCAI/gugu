import assert from 'node:assert/strict';
import { nativeImage } from 'electron';
import type { BridgeCaller } from '../extension-bridge';
import { extensionProjections as bridge } from '../extension-projection-bridge';
import { createProjectionImageDecoder } from '../projection-image';
import type { projectionSources } from '../../../../../../src/session/app-runtime/projection-source';
import type { ProjectionFrame } from '@shared/extensions/projection-protocol';
import type { MediaProcess } from '../../../../../../native/projection-media/node/host.mjs';
import type { ProjectionSignalContext } from '../../../../../../native/projection-media/node/signaling.mjs';

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
type Runtime = ReturnType<typeof projectionSources>;

/** Actual installed source grants and NativeImage; controlled encoders expose borrow overlap. */
export async function probeFeedOwnership(runtime: Runtime, page: BridgeCaller, context: ProjectionSignalContext,
  picture: Omit<ProjectionFrame, 'sequence'>, startNative: () => Promise<MediaProcess>) {
  const createSource = async () => {
    const source = await runtime.create({ input: async () => {}, disconnect: async () => {}, close() {},
      refresh: async () => { await source.publish(picture); } });
    return source;
  };
  const makeDecoder = () => createProjectionImageDecoder(nativeImage.createFromBuffer, { r: 0, g: 0, b: 0 });
  const source = await createSource(), created = deferred(), started = deferred<Promise<MediaProcess>>();
  const cancel = new AbortController(), reason = new Error('Late media fixture cancelled');
  let physicallyClosed = false, native: MediaProcess | undefined;
  const late = bridge.mediaFeed(page, source.id, context, makeDecoder, async () => {
    const starting = startNative(); started.resolve(starting);
    native = await starting;
    void native.closed.then(() => { physicallyClosed = true; }, () => { physicallyClosed = true; });
    await created.promise; return native;
  });
  const opening = late.openMedia(cancel.signal, () => {}).then(() => undefined, error => error);
  try {
    await started.promise;
    cancel.abort(reason); created.resolve();
    assert.equal(await opening, reason);
    assert.equal(physicallyClosed, true, 'late real helper must physically exit before initialization rejects');
  } finally {
    created.resolve(); await native?.close(); await opening;
    await late.lease.disconnect(); late.lease.release(); await source.close();
  }

  const buildStream = async () => {
    const publisher = await createSource(), held = deferred(), closed = deferred();
    const buffers: Uint8Array[] = [];
    let generation = '';
    const media: MediaProcess = {
      offer: { type: 'offer', sdp: 'controlled encoder' }, closed: closed.promise, answer: async () => {},
      sendControl: async data => { generation = JSON.parse(data).generation; },
      publish: async (sequence, pixels) => { buffers.push(pixels); if (sequence === 1) await held.promise;
        return { sequence, width: picture.width, height: picture.height, rtpTimestamp: sequence * 9000 }; },
      close: async () => { closed.resolve(); },
    };
    const feed = bridge.mediaFeed(page, publisher.id, context, makeDecoder, async () => media);
    const opened = await feed.openMedia(new AbortController().signal, () => {});
    await opened.answer({ type: 'answer', sdp: 'controlled encoder' });
    return { publisher, feed, media, buffers, held, generation: () => generation };
  };
  const streams: Awaited<ReturnType<typeof buildStream>>[] = [];
  try {
    streams.push(await buildStream()); streams.push(await buildStream());
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!condition()) {
        for (const stream of streams) stream.feed.lease.signal.throwIfAborted();
        if (Date.now() > deadline) throw new Error('Concurrent NativeImage lease probe timed out');
        await pause();
      }
    };
    await until(() => streams.every(stream => stream.buffers.length === 1));
    assert.notEqual(streams[0]!.buffers[0], streams[1]!.buffers[0]);
    for (const stream of streams) stream.held.resolve();
    await pause(); await pause();
    for (const stream of streams) {
      await stream.feed.lease.receive(JSON.stringify({ type: 'ack', generation: stream.generation(), frame: 1 }), new AbortController().signal);
      assert.equal(await stream.publisher.publish(picture), 2);
    }
    await until(() => streams.every(stream => stream.buffers.length === 2));
    for (const stream of streams) assert.equal(stream.buffers[0], stream.buffers[1]);
  } finally {
    for (const stream of streams) stream.held.resolve();
    await pause();
    for (const stream of streams) {
      await stream.media.close(); await stream.feed.lease.disconnect(); stream.feed.lease.release(); await stream.publisher.close();
    }
  }
  return { lateHelperExited: physicallyClosed, concurrentNativeDecoders: streams.length, reusedPerStream: true };
}
