import { PROJECTION_UNCONFIRMED, isProjectionRelease, type ProjectionInputOutcome, type ProjectionViewerPacket } from '@shared/extensions/projection-protocol';
type Packet = Extract<ProjectionViewerPacket, { type: 'input' }>;
type Entry = { packet: Packet; sent?: () => void; promise: Promise<ProjectionInputOutcome>; resolve(value: ProjectionInputOutcome): void };
export class ProjectionInputNotSent extends Error {}

/** A bounded local queue. Metadata is captured at intent time, never rebound to a newer target/frame. */
export class ProjectionInputQueue {
  private readonly queued: Entry[] = [];
  private busy = false;
  constructor(private readonly send: (packet: Packet) => Promise<ProjectionInputOutcome | void>, private readonly release: () => Promise<void>) {}
  push(packet: Packet, sent?: () => void): Promise<ProjectionInputOutcome> {
    const previous = this.queued.at(-1);
    if (previous && this.merge(previous.packet, packet)) return previous.promise;
    if (this.queued.length >= 64) {
      if (!isProjectionRelease(packet.input)) return Promise.resolve({ status: 'rejected', reason: 'Projection input queue is full' });
      // A release is a barrier. Reject ordinary, undispatched work explicitly
      // rather than leaving a previously delivered down held on the target.
      for (let index = this.queued.length - 1; index >= 0; index--) {
        const entry = this.queued[index]!;
        if (!isProjectionRelease(entry.packet.input)) {
          this.queued.splice(index, 1);
          entry.resolve({ status: 'rejected', reason: 'Projection queue cleared to release held input' });
        }
      }
      const sameRelease = this.queued.find(entry => entry.packet.generation === packet.generation && entry.packet.frame === packet.frame
        && JSON.stringify(entry.packet.input) === JSON.stringify(packet.input));
      if (sameRelease) return sameRelease.promise;
      // Even a flood consisting entirely of different releases stays bounded.
      // Disconnecting this generation releases every held control in the driver.
      if (this.queued.length >= 64) {
        this.clear();
        return this.release().then(() => ({ status: 'rejected' as const, reason: 'Projection input generation reset to release held input' }));
      }
    }
    const { promise, resolve } = Promise.withResolvers<ProjectionInputOutcome>();
    this.queued.push({ packet, sent, promise, resolve });
    void this.drain();
    return promise;
  }
  clear() {
    for (const entry of this.queued.splice(0)) entry.resolve({ status: 'rejected', reason: 'Projection generation changed before dispatch' });
  }
  private merge(a: Packet, b: Packet): boolean {
    if (a.generation !== b.generation || a.frame !== b.frame
      || JSON.stringify(a.input.kind === 'text' ? [] : a.input.modifiers) !== JSON.stringify(b.input.kind === 'text' ? [] : b.input.modifiers)) return false;
    const x = a.input; const y = b.input;
    if (x.kind === 'pointer' && y.kind === 'pointer' && x.action === 'move' && y.action === 'move' && x.button === y.button) {
      a.input = y;
    } else if (x.kind === 'wheel' && y.kind === 'wheel' && Math.abs(x.deltaX + y.deltaX) <= 10_000 && Math.abs(x.deltaY + y.deltaY) <= 10_000) {
      a.input = { ...y, deltaX: x.deltaX + y.deltaX, deltaY: x.deltaY + y.deltaY };
    } else return false;
    a.sequence = b.sequence;
    return true;
  }
  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queued.length) {
        const entry = this.queued.shift()!;
        entry.sent?.();
        try {
          const result = await this.send(entry.packet) ?? { status: 'applied' as const };
          if (result.status === 'unknown') this.clear();
          entry.resolve(result);
        }
        catch { this.clear(); entry.resolve({ status: 'unknown', reason: PROJECTION_UNCONFIRMED }); }
      }
    } finally { this.busy = false; }
  }
}
