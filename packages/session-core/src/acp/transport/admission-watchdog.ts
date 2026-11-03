import type { NormalizedEvent } from '../reducer/normalized-event';

/** Watches inactivity, not receipt latency. Expiry reports uncertainty without withdrawing the request. */
export class AdmissionWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly compactions = new Set<string>();
  private ended = false;

  constructor(private readonly idleMs: number, private readonly uncertain: () => void) {
    this.arm();
  }

  observe(event: NormalizedEvent): void {
    if (this.ended) return;
    if (event.kind === 'compaction') {
      if (event.status === 'in_progress') this.compactions.add(event.compactionId);
      else if (event.status) this.compactions.delete(event.compactionId);
    }
    this.activity();
  }

  activity(): void {
    if (this.ended) return;
    this.clear();
    // Native compaction is a declared operation with start/end edges, not a periodic heartbeat.
    if (this.compactions.size === 0) this.arm();
  }

  close(): void { this.ended = true; this.clear(); }

  private arm(): void {
    this.timer = setTimeout(() => {
      this.ended = true;
      this.timer = undefined;
      this.uncertain();
    }, this.idleMs);
    this.timer.unref?.();
  }

  private clear(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
}
