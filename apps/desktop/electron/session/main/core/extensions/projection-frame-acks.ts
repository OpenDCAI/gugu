import type { ProjectionViewerPacket } from '@shared/extensions/projection-protocol';

type Ack = Extract<ProjectionViewerPacket, { type: 'ack' }>;

/** Loss recovery can repaint an already acknowledged source frame with new RTP stamps. */
export class ProjectionFrameAcks {
  private acknowledged = 0;
  private readonly pending = new Map<number, Promise<void>>();
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly check: () => void, private readonly generation: () => string | undefined,
    private readonly receive: (packet: Ack) => Promise<void>) {}

  receiveAck(packet: Ack): Promise<void> {
    this.check();
    if (packet.generation !== this.generation()) throw new Error('Stale projection frame');
    const existing = this.pending.get(packet.frame);
    if (existing) return existing;
    if (this.pending.size >= 64) throw new Error('Projection frame acknowledgement queue is full');
    const task = this.tail.then(async () => {
      this.check();
      if (packet.generation !== this.generation()) throw new Error('Stale projection frame');
      if (packet.frame === this.acknowledged) return;
      await this.receive(packet);
      this.check();
      this.acknowledged = packet.frame;
    });
    this.pending.set(packet.frame, task);
    this.tail = task.then(() => { this.pending.delete(packet.frame); }, () => { this.pending.delete(packet.frame); });
    return task;
  }
}
