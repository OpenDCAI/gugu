import { projectionInput, type ProjectionFrame, type ProjectionHostPacket, type ProjectionInput } from '@shared/extensions/projection-protocol';
import { ProjectionInputQueue, ProjectionInputNotSent } from './projection-input-queue';
import type { ProjectionHost } from './projection-source';

/** Renderers ACK after paint, not after receiving bytes. No queued input survives a lost generation. */
export async function projectionClient(host: ProjectionHost, id: string, options: {
  paint(frame: ProjectionFrame, current: () => boolean): Promise<void>;
  state?(state: 'connecting' | 'live' | 'closed', reason?: string): void;
  error?(error: unknown): void;
  painted?(frame: Pick<ProjectionFrame, 'sequence' | 'width' | 'height'> | null): void;
}) {
  const watchId = crypto.randomUUID();
  const bridge = host.projection!;
  let generation = '';
  let painted = 0;
  let sequence = 0;
  let closed = false;
  let ready = false;
  let painting = Promise.resolve();
  let paintEpoch = 0;
  let resetting: Promise<void> | null = null;
  const inputs = new ProjectionInputQueue(packet => bridge.send({ watchId, packet }), () => reset());
  const state = (value: 'connecting' | 'live' | 'closed', reason?: string) => {
    ready = value === 'live';
    if (!ready) { paintEpoch++; options.painted?.(null); }
    options.state?.(value, reason);
  };
  const receive = async (packet: ProjectionHostPacket) => {
    if (closed) return;
    if (packet.type === 'state') {
      if (packet.state === 'connecting') {
        inputs.clear();
        generation = packet.generation;
        painted = sequence = 0;
        state('connecting');
      } else if (packet.generation === generation && packet.state === 'closed') {
        inputs.clear();
        generation = '';
        painted = 0;
        state('closed', packet.reason);
      }
      return;
    }
    if (packet.generation !== generation || packet.frame.sequence <= painted) return;
    const current = () => !closed && packet.generation === generation && packet.frame.sequence > painted;
    let epoch = 0;
    const work = painting.then(async () => {
      if (!current()) return false;
      epoch = ++paintEpoch;
      ready = false;
      // Serial painting prevents an older decode from replacing a newer picture.
      options.painted?.(null);
      await options.paint(packet.frame, current);
      if (!current()) return false;
      painted = packet.frame.sequence;
      options.painted?.({ sequence: painted, width: packet.frame.width, height: packet.frame.height });
      return true;
    });
    // An ACK may stall independently of decoding the next generation's picture.
    painting = work.then(() => {}, () => {});
    try {
      if (!await work) return;
      await bridge.send({ watchId, packet: { type: 'ack', generation: packet.generation, frame: packet.frame.sequence } });
      if (!closed && packet.generation === generation && paintEpoch === epoch) state('live');
    } catch (error) {
      if (closed || packet.generation !== generation || paintEpoch !== epoch) return;
      ready = false;
      options.painted?.(null);
      options.error?.(error);
    }
  };
  const off = host.onProjection!((watch, packet) => {
    if (watch === watchId) void receive(packet);
  });
  state('connecting');
  try { await bridge.watch({ id, watchId }); }
  catch (error) { closed = true; off(); state('closed'); throw error; }
  function reset() {
      if (closed) return Promise.reject(new Error('Projection is closed'));
      if (resetting) return resetting;
      inputs.clear();
      generation = '';
      painted = sequence = 0;
      state('connecting');
      resetting = bridge.watch({ id, watchId }).catch(error => {
        state('closed', error instanceof Error ? error.message : String(error));
        throw error;
      }).finally(() => { resetting = null; });
      return resetting;
  }
  return Object.freeze({
    reset,
    input(raw: ProjectionInput, sent?: () => void) {
      if (closed || !ready || !painted) return Promise.reject(new ProjectionInputNotSent('Projection is not ready for input'));
      let input: ProjectionInput;
      try { input = projectionInput(raw); }
      catch (error) { return Promise.reject(new ProjectionInputNotSent(error instanceof Error ? error.message : String(error))); }
      return inputs.push({ type: 'input', generation, frame: painted, sequence: ++sequence, input }, sent);
    },
    async close() {
      if (closed) return;
      closed = true;
      inputs.clear();
      ready = false;
      off();
      try { await bridge.unwatch({ watchId }); }
      finally { state('closed'); }
    },
  });
}
