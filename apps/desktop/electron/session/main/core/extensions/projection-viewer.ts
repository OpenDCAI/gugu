import type { ProjectionFrame, ProjectionHostPacket, ProjectionViewerPacket } from '@shared/extensions/projection-protocol';

/** A host-owned connection. App arguments must never choose its scope or transport. */
export interface ProjectionConnection {
  transport: 'local';
  send(packet: ProjectionHostPacket): void;
  onClose(close: () => void): () => void;
}

/** Local preview only: one outstanding picture and its newest replacement. Not a network video protocol. */
export class ProjectionViewer {
  readonly abort = new AbortController();
  private sent: ProjectionFrame | null = null;
  private pending: ProjectionFrame | null = null;
  private visible: ProjectionFrame | null = null;
  private inputSequence = 0;
  private off: () => void = () => {};

  constructor(readonly generation: string, private readonly baseline: number, readonly connection: ProjectionConnection,
    private readonly gone: (viewer: ProjectionViewer) => void) {
    this.post({ type: 'state', generation, state: 'connecting' });
    const off = connection.onClose(() => this.close('Connection closed'));
    if (this.abort.signal.aborted) off();
    else this.off = off;
  }

  private post(packet: ProjectionHostPacket): void {
    if (this.abort.signal.aborted) return;
    try { this.connection.send(packet); }
    catch { this.close('Connection closed'); }
  }

  publish(frame: ProjectionFrame): void {
    if (this.abort.signal.aborted || frame.sequence <= this.baseline) return;
    if (this.sent) { this.pending = frame; return; }
    this.sent = frame;
    this.post({ type: 'frame', generation: this.generation, frame });
  }

  ack(packet: Extract<ProjectionViewerPacket, { type: 'ack' }>): void {
    this.abort.signal.throwIfAborted();
    if (packet.generation !== this.generation || packet.frame !== this.sent?.sequence) throw new Error('Stale projection frame');
    this.visible = this.sent;
    this.sent = null;
    this.post({ type: 'state', generation: this.generation, state: 'live' });
    const pending = this.pending;
    this.pending = null;
    if (pending) this.publish(pending);
  }

  admit(packet: Extract<ProjectionViewerPacket, { type: 'input' }>): ProjectionFrame {
    this.assertVisible(packet.generation, packet.frame);
    if (packet.sequence <= this.inputSequence) throw new Error('Stale projection input');
    this.inputSequence = packet.sequence;
    return this.visible!;
  }

  assertVisible(generation: string, frame: number): void {
    this.abort.signal.throwIfAborted();
    if (generation !== this.generation || frame !== this.visible?.sequence) throw new Error('Stale projection input');
  }

  close(reason: string): void {
    if (this.abort.signal.aborted) return;
    this.abort.abort(new Error(reason));
    this.off();
    this.sent = this.pending = this.visible = null;
    this.gone(this);
    try { this.connection.send({ type: 'state', generation: this.generation, state: 'closed', reason }); }
    catch { /* A lost connection has no recipient for its final state. */ }
  }
}
