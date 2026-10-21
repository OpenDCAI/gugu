import { computed, makeObservable, observable, runInAction } from 'mobx';
import { events, rpc } from '@renderer/lib/ipc';
import { resourceSnapshotChannel } from '@shared/events/resourceEvents';
import type { ResourcePtyEntry, ResourceSnapshot } from '@shared/resource-monitor';

export class ResourceMonitorStore {
  snapshot: ResourceSnapshot | null = null;
  /** The snapshot before `snapshot`, so the view can difference cumulative CPU seconds and counters. */
  previousSnapshot: ResourceSnapshot | null = null;
  isLoadingInitialSnapshot = false;
  private offSnapshot: (() => void) | null = null;
  private clientId = crypto.randomUUID();
  private sequence = 0;
  private subscriptionId: string | null = null;

  constructor() {
    makeObservable(this, {
      snapshot: observable,
      previousSnapshot: observable.ref,
      isLoadingInitialSnapshot: observable,
      totalCpuPercent: computed,
      totalMemoryBytes: computed,
      appMemoryBytes: computed,
      agentMemoryBytes: computed,
      entryCount: computed,
    });
  }

  /**
   * Total CPU usage as a fraction of the whole machine (0 - 100+%).
   * pidusage reports each PID as % of one core; divide by core count to
   * normalize against total CPU capacity. Undefined until the app's own processes have a reading.
   */
  get totalCpuPercent(): number | undefined {
    const snap = this.snapshot;
    if (!snap || snap.cpuCount === 0 || snap.app.cpuPercent === undefined) return undefined;
    let sum = snap.app.cpuPercent;
    for (const e of snap.entries) sum += e.cpu;
    return sum / snap.cpuCount;
  }

  get totalMemoryBytes(): number {
    return this.appMemoryBytes + this.agentMemoryBytes;
  }

  get appMemoryBytes(): number {
    return this.snapshot?.app?.memoryBytes ?? 0;
  }

  get agentMemoryBytes(): number {
    if (!this.snapshot) return 0;
    let sum = 0;
    for (const e of this.snapshot.entries) sum += e.memory;
    return sum;
  }

  get entryCount(): number {
    return this.snapshot?.entries.length ?? 0;
  }

  start(): void {
    if (this.subscriptionId) return;
    const subscriptionId = crypto.randomUUID();
    this.subscriptionId = subscriptionId;
    runInAction(() => {
      this.snapshot = null;
      this.previousSnapshot = null;
      this.isLoadingInitialSnapshot = true;
    });
    const onSnapshot = (snap: ResourceSnapshot | null) => {
      if (this.subscriptionId !== subscriptionId) return;
      runInAction(() => {
        if (snap) this.applyFetchedSnapshot(snap);
        this.isLoadingInitialSnapshot = false;
      });
    };
    this.offSnapshot = events.on(resourceSnapshotChannel, onSnapshot);
    void rpc.resourceMonitor.setOpen(this.clientId, subscriptionId, true, ++this.sequence).catch(() => onSnapshot(null));
  }

  dispose(): void {
    const subscriptionId = this.subscriptionId;
    if (!subscriptionId) return;
    this.offSnapshot?.();
    this.offSnapshot = null;
    runInAction(() => {
      this.isLoadingInitialSnapshot = false;
    });
    this.subscriptionId = null;
    void rpc.resourceMonitor.setOpen(this.clientId, subscriptionId, false, ++this.sequence);
  }

  async refresh(): Promise<void> {
    const subscriptionId = this.subscriptionId;
    if (!subscriptionId) return;
    const res = await rpc.resourceMonitor.getSnapshot();
    if (this.subscriptionId !== subscriptionId || !res?.success || !res.data) return;
    runInAction(() => {
      this.applyFetchedSnapshot(res.data);
    });
  }

  private applyFetchedSnapshot(snap: ResourceSnapshot): void {
    if (this.snapshot && this.snapshot.timestamp > snap.timestamp) return;
    this.previousSnapshot = this.snapshot;
    this.snapshot = snap;
  }

  /** Normalized CPU% (relative to all cores) for a single entry. */
  normalizedCpu(entry: ResourcePtyEntry): number {
    if (!this.snapshot || this.snapshot.cpuCount === 0) return 0;
    return entry.cpu / this.snapshot.cpuCount;
  }
}
