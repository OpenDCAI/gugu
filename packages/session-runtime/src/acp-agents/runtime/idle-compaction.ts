/** The captured 388-entry / 169,103-token request puts 120k at roughly 275 entries. */
export const ASSISTANT_IDLE_COMPACT_TOKENS = 120_000;
/** Run before the cloud host's ordinary idle suspension, without waking it for maintenance. */
export const ASSISTANT_IDLE_COMPACT_MS = 60_000;

export interface IdleCompactionState {
  idle: boolean;
  contextTokens: number | null;
  /** Changes only when real input or a native history load is admitted. */
  revision: number;
}

/** A live-session timer, never a persistent job or a reason to start/resume an engine. */
export class IdleCompaction {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attemptedRevision: number | null = null;
  private closed = false;

  constructor(
    private readonly read: () => IdleCompactionState,
    private readonly compact: () => Promise<void>,
    private readonly failed: (error: unknown) => void = () => undefined,
  ) {}

  update(): void {
    if (this.closed) return;
    const state = this.read();
    if (!this.eligible(state)) { this.clear(); return; }
    if (this.timer) return;
    const revision = state.revision;
    const deadline = Date.now() + ASSISTANT_IDLE_COMPACT_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      const current = this.read();
      // A frozen/suspended process must not compact on wake before its waiting inbox arrives.
      if (Date.now() > deadline + 5_000) { this.update(); return; }
      if (this.closed || !this.eligible(current) || current.revision !== revision) {
        this.update();
        return;
      }
      // Failed commands, and stale usage readings after successful compaction, cannot spin.
      this.attemptedRevision = revision;
      void this.compact().catch(this.failed);
    }, ASSISTANT_IDLE_COMPACT_MS);
    this.timer.unref?.();
  }

  close(): void { this.closed = true; this.clear(); }

  private eligible(state: IdleCompactionState): boolean {
    return state.idle && state.contextTokens !== null
      && state.contextTokens >= ASSISTANT_IDLE_COMPACT_TOKENS
      && state.revision !== this.attemptedRevision;
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
