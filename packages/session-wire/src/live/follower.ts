import { log as ambientLog, type Logger } from '@gugu/session-shared/logger';
import type { WireInstrumentation, WireResyncReason } from '../observability';
import type { LiveCursor, LiveSnapshot, LiveUpdate } from './protocol';

export type LiveFollowerApplyResult =
  | { ok: true }
  | { ok: false; reason: WireResyncReason; details?: Record<string, unknown> };

export interface LiveMaterializer<T> {
  seed(snapshot: LiveSnapshot<T>): void;
  apply(update: LiveUpdate): LiveFollowerApplyResult;
}

type LiveFollowerOptions = {
  instrumentation?: WireInstrumentation;
  logger?: Logger;
  topic?: string;
  label: string;
  onSeeded?: () => void;
  onApplied?: (update: LiveUpdate) => void;
};

export class LiveFollower<T> {
  private generation = -1;
  private sequence = -1;
  private resyncing: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly refetchSnapshot: () => Promise<LiveSnapshot<T>>,
    private readonly materializer: LiveMaterializer<T>,
    private readonly options: LiveFollowerOptions
  ) {}

  get cursor(): LiveCursor | undefined {
    if (this.generation < 0) return undefined;
    return {
      generation: this.generation,
      sequence: this.sequence,
    };
  }

  isReady(): boolean {
    return this.generation >= 0;
  }

  seed(snapshot: LiveSnapshot<T>): void {
    this.materializer.seed(snapshot);
    this.generation = snapshot.generation;
    this.sequence = snapshot.sequence;
    this.options.onSeeded?.();
  }

  applyUpdate(update: LiveUpdate): void {
    if (!this.isReady()) {
      this.triggerResync('sequence-gap', { reason: 'update-before-seed' });
      return;
    }

    if (update.generation !== this.generation) {
      this.triggerResync('generation', {
        local: this.generation,
        incoming: update.generation,
      });
      return;
    }

    if (update.baseSequence !== this.sequence) {
      this.triggerResync('sequence-gap', {
        expected: this.sequence,
        got: update.baseSequence,
      });
      return;
    }

    const applied = this.materializer.apply(update);
    if (!applied.ok) {
      this.triggerResync(applied.reason, applied.details ?? {});
      return;
    }

    this.sequence = update.sequence;
    this.options.onApplied?.(update);
  }

  /** 在途时又被要一次:这次取完再取一次,❌ 丢掉 —— 上游实例拆掉又马上建回来,丢掉后一次就停在 NOT_FOUND 上。 */
  refresh(): Promise<void> {
    if (this.resyncing) {
      this.again = true;
      return this.resyncing;
    }
    const run = async (): Promise<void> => {
      this.again = false;
      try {
        this.seed(await this.refetchSnapshot());
      } catch (error) {
        if (!this.again) throw error;
      }
      if (this.again) return run();
    };
    this.resyncing = run().finally(() => {
      this.resyncing = null;
    });
    return this.resyncing;
  }

  protected triggerResync(reason: WireResyncReason, details: Record<string, unknown> = {}): void {
    const event = { topic: this.options.topic, reason, details };
    this.options.instrumentation?.resync?.(event);
    (this.options.logger ?? ambientLog).warn(`wire ${this.options.label} resyncing`, event);
    void this.refresh();
  }
}
