import { projectionInput, type ProjectionFrame, type ProjectionHostPacket, type ProjectionInput } from '@shared/extensions/projection-protocol';
import { ProjectionInputQueue, ProjectionInputNotSent } from './projection-input-queue';
import type { ProjectionHost } from './projection-source';

/** Renderers ACK after paint, not after receiving bytes. No queued input survives a lost generation. */
export async function projectionClient(host: ProjectionHost, id: string, options: {
  paint(frame: ProjectionFrame): Promise<void>;
  state?(state: 'connecting' | 'live' | 'closed', reason?: string): void;
  error?(error: unknown): void;
}) {
  const watchId = crypto.randomUUID();
  const bridge = host.projection!;
  let generation = '';
  let painted = 0;
  let sequence = 0;
  let closed = false;
  let ready = false;
  let resetting: Promise<void> | null = null;
  const inputs = new ProjectionInputQueue(packet => bridge.send({ watchId, packet }), () => reset());
  const state = (value: 'connecting' | 'live' | 'closed', reason?: string) => {
    ready = value === 'live';
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
    try {
      await options.paint(packet.frame);
      if (closed || packet.generation !== generation) return;
      painted = packet.frame.sequence;
      await bridge.send({ watchId, packet: { type: 'ack', generation, frame: painted } });
      if (!closed && packet.generation === generation) state('live');
    } catch (error) {
      ready = false;
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
