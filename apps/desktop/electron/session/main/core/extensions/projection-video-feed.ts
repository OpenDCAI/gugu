import {
  projectionViewerPacket, PROJECTION_NOT_SENT, PROJECTION_UNCONFIRMED,
  type ProjectionFrame, type ProjectionHostPacket,
} from '@shared/extensions/projection-protocol';
import type { MediaProcess } from '../../../../../native/projection-media/node/host.mjs';
import type { ProjectionSignalContext, ProjectionSignalLease } from '../../../../../native/projection-media/node/signaling.mjs';
import { ProjectionInputFailure, type ExtensionProjections } from './extension-projections';
import type { ProjectionMediaAccess } from './projection-media-access';
import type { ProjectionPixelLease } from './projection-image';
import { ProjectionFrameAcks } from './projection-frame-acks';

type Authority = ReturnType<ProjectionMediaAccess['open']>;
type Connection = ReturnType<ExtensionProjections['connect']>;
type Decoder = (frame: Readonly<ProjectionFrame>, signal: AbortSignal) => Promise<ProjectionPixelLease>;
type CreateMedia = (size: { width: number; height: number }, signal: AbortSignal,
  onControl: (data: string) => void) => Promise<MediaProcess>;

/** The bitmap stays inside this process. Only the encoder's H264 track and metadata leave it. */
export function projectionVideoFeed(resources: ExtensionProjections, authority: Authority,
  context: ProjectionSignalContext, decode: Decoder, createMedia: CreateMedia) {
  authority.assertCurrent();
  if (context.appId !== authority.extensionId || context.sessionId !== authority.sessionId
    || context.pageId !== String(authority.pageId) || context.epoch !== String(authority.epoch)) {
    authority.release();
    throw new Error('Projection media authority does not match its host context');
  }
  const lifetime = new AbortController();
  let connection: Connection | undefined;
  let media: MediaProcess | undefined;
  let latest: ProjectionFrame | undefined;
  let generation: string | undefined;
  let ready = false, encoding = false, opening = false;
  let published = 0;
  const stop = (reason: unknown) => {
    lifetime.abort(reason instanceof Error ? reason : new Error(String(reason)));
    latest = undefined;
    connection?.close();
  };
  const revoke = () => stop(authority.signal.reason);
  authority.signal.addEventListener('abort', revoke, { once: true });
  if (authority.signal.aborted) revoke();
  const check = () => { lifetime.signal.throwIfAborted(); authority.assertCurrent(); };
  let resolveFirst!: (frame: ProjectionFrame) => void;
  const first = new Promise<ProjectionFrame>(resolve => { resolveFirst = resolve; });

  const pump = async () => {
    if (!ready || encoding || !latest || lifetime.signal.aborted) return;
    encoding = true;
    try {
      while (latest) {
        const frame = latest; latest = undefined;
        check();
        // Resolution changes need a new negotiated stream; never encode against
        // the old geometry and then accept input in a different target space.
        if (frame.width !== size!.width || frame.height !== size!.height) throw new Error('Projection video geometry changed');
        const pixels = await decode(Object.freeze({ ...frame }), lifetime.signal);
        try {
          check();
          if (!(pixels.data instanceof Uint8Array) || pixels.data.byteLength !== frame.width * frame.height * 4) {
            throw new Error('Projection decoder returned invalid BGRA pixels');
          }
          published = frame.sequence;
          const receipt = await media!.publish(frame.sequence, pixels.data);
          check();
          if (receipt.sequence !== frame.sequence || receipt.width !== frame.width || receipt.height !== frame.height) {
            throw new Error('Projection encoded receipt does not match its resource frame');
          }
        } finally { pixels.release(); }
      }
    } catch (error) { stop(error); }
    finally { encoding = false; }
  };
  let size: { width: number; height: number } | undefined;
  const picture = (packet: ProjectionHostPacket) => {
    if (lifetime.signal.aborted) return;
    if (packet.type === 'state') {
      generation = packet.generation;
      if (packet.state === 'closed') stop(new Error(packet.reason ?? 'Projection source closed'));
      return;
    }
    generation = packet.generation;
    latest = packet.frame;
    resolveFirst(packet.frame);
    void pump();
  };
  try {
    connection = resources.connect({ extensionId: authority.extensionId, sessionId: authority.sessionId }, authority.sourceId, {
      transport: 'local', send: picture,
      onClose: close => {
        lifetime.signal.addEventListener('abort', close, { once: true });
        if (lifetime.signal.aborted) close();
        return () => lifetime.signal.removeEventListener('abort', close);
      },
    });
    check();
  } catch (error) { authority.signal.removeEventListener('abort', revoke); stop(error); authority.release(); throw error; }
  const acks = new ProjectionFrameAcks(check, () => generation, packet => connection!.receive(packet));

  const lease: ProjectionSignalLease = {
    context: Object.freeze({ ...context }), sourceId: authority.sourceId, signal: lifetime.signal,
    async assertCurrent() { check(); },
    async receive(data, signal) {
      check(); signal.throwIfAborted();
      if (Buffer.byteLength(data) > 16 * 1024) throw new Error('Projection control is too large');
      const packet = projectionViewerPacket(JSON.parse(data));
      if (packet.type === 'ack' && packet.frame > published) throw new Error('Projection frame has not been encoded');
      const cancelled = () => stop(signal.reason);
      signal.addEventListener('abort', cancelled, { once: true });
      try {
        if (packet.type === 'ack') await acks.receiveAck(packet);
        else await connection!.receive(packet);
        check(); signal.throwIfAborted();
        return packet.type === 'input'
          ? JSON.stringify({ type: 'input-result', generation: packet.generation, sequence: packet.sequence, status: 'applied' }) : undefined;
      } catch (error) {
        signal.throwIfAborted(); check();
        if (packet.type !== 'input') throw error;
        const outcome = error instanceof ProjectionInputFailure && error.outcome ? error.outcome
          : error instanceof ProjectionInputFailure && error.uncertain
            ? { status: 'unknown', reason: PROJECTION_UNCONFIRMED } : { status: 'rejected', reason: PROJECTION_NOT_SENT };
        return JSON.stringify({ type: 'input-result', generation: packet.generation, sequence: packet.sequence, ...outcome });
      } finally { signal.removeEventListener('abort', cancelled); }
    },
    async disconnect() { stop(new Error('Projection video disconnected')); await connection!.disconnect(); },
    release() {
      stop(new Error('Projection video authority released'));
      authority.signal.removeEventListener('abort', revoke); authority.release();
    },
  };
  return {
    lease,
    async openMedia(signal: AbortSignal, onControl: (data: string) => void): Promise<MediaProcess> {
      if (opening) throw new Error('Projection video is already opening');
      opening = true;
      const cancelled = () => stop(signal.reason);
      signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted) cancelled();
      const timer = setTimeout(() => stop(new Error('Projection source did not publish a fresh frame')), 10_000);
      let offFirst = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(lifetime.signal.reason);
        lifetime.signal.addEventListener('abort', abort, { once: true });
        // Removed after the first-frame wait below, including early cancellation.
        offFirst = () => lifetime.signal.removeEventListener('abort', abort);
        if (lifetime.signal.aborted) abort();
      });
      try {
        const frame = await Promise.race([first, aborted]);
        clearTimeout(timer); offFirst(); check();
        size = { width: frame.width, height: frame.height };
        media = await createMedia(size, lifetime.signal, onControl);
        check();
        void media.closed.then(() => stop(new Error('Projection media closed')), stop);
        const native = media;
        return Object.freeze({ ...native,
          async answer(sdp: Parameters<MediaProcess['answer']>[0]) {
            check(); await native.answer(sdp); check();
            await native.sendControl(JSON.stringify({ type: 'projection-generation', generation }));
            check(); ready = true; void pump();
          },
          async close() {
            signal.removeEventListener('abort', cancelled);
            stop(new Error('Projection video closed'));
            try { await native.close(); }
            catch (error) { if (error !== lifetime.signal.reason) throw error; }
          },
        });
      } catch (error) {
        signal.removeEventListener('abort', cancelled); stop(error); throw error;
      } finally { clearTimeout(timer); offFirst(); }
    },
  };
}
