import { Emitter, type Unsubscribe } from '@gugu/session-shared';
import { log, type Logger } from '@gugu/session-shared/logger';
import type { z } from 'zod';
import type { LiveClientHandle } from '../../api/client';
import type { WireError } from '../../api/protocol';
import type { WireInstrumentation } from '../../observability';
import { LiveFollower } from '../follower';
import type { LiveCursor, LiveSnapshot, LiveSource, LiveUpdate } from '../protocol';
import type { LiveChangeMeta } from '../state';
import { LiveStateWaiters } from '../state/waiters';
import { detachSettled, releaseOnFailedReady } from './release';
import { createPlainStore, createStateMaterializer, type StateStore } from './store';

export type ReplicaStateOptions<T> = {
  store?: StateStore<T>;
  schema?: z.ZodType<T>;
  onChange?: (value: T, meta: LiveChangeMeta) => void;
  instrumentation?: WireInstrumentation;
  logger?: Logger;
};

type ReplicaStateChange<T> = {
  value: T;
  meta: LiveChangeMeta;
};

export class ReplicaState<T> implements LiveSource {
  readonly ready: Promise<void>;

  private readonly emitter = new Emitter<LiveUpdate>();
  private readonly changeEmitter = new Emitter<ReplicaStateChange<T>>();
  private readonly goneEmitter = new Emitter<WireError>();
  private readonly follower: LiveFollower<T>;
  private readonly store: StateStore<T>;
  private readonly waiters = new LiveStateWaiters(() => this.cursor);
  private readonly localWaiters = new LiveStateWaiters(() => this.localCursor());
  private readonly detachPromise: Promise<Unsubscribe>;
  private localGeneration = nextGeneration();
  private localSequence = 0;
  private upstreamBase: LiveCursor | undefined;
  /** Attach precedes the first snapshot, so updates arriving in that window are expected. */
  private initialUpdates: LiveUpdate[] | null = [];
  private disposed = false;

  constructor(
    private readonly handle: LiveClientHandle<T>,
    private readonly deps: ReplicaStateOptions<T> = {}
  ) {
    this.store = deps.store ?? createPlainStore<T>();
    this.follower = new LiveFollower(
      () => handle.snapshot(),
      createStateMaterializer(this.store, deps.schema),
      {
        instrumentation: deps.instrumentation,
        logger: deps.logger,
        topic: handle.topic,
        label: 'replica model',
        onSeeded: () => this.handleSeeded(),
        onApplied: (update) => this.handleApplied(update),
      }
    );
    // Share the follower's in-flight read with reattach/gap recovery. A separate
    // initial read could finish last and overwrite a newer recovered snapshot.
    this.detachPromise = handle.attach((update) => this.applyUpdate(update), {
      // 重取时 NOT_FOUND = 上游此刻没有这份实例(拆了 / 进程重启过,#7327):告诉持有者;副本照旧挂着(@@@follow-key)。
      onReattach: () =>
        void this.refresh().catch((error: unknown) => {
          if ((error as WireError | null)?.code === 'NOT_FOUND') this.goneEmitter.emit(error as WireError);
          else (deps.logger ?? log).warn('wire replica refresh failed', { topic: handle.topic, error: String(error) });
        }),
      // 重连被拒且不会再好(非 keyed 主题),连接删掉这条 attach:❌ 不吭声。可重试的(DISCONNECTED)由连接自己重试。
      onReattachError: (error, { retrying }) => {
        if (!retrying) this.goneEmitter.emit(error);
      },
    });
    const initialSnapshot = this.follower.refresh();
    this.ready = releaseOnFailedReady(
      Promise.all([initialSnapshot, this.detachPromise]).then(() => undefined),
      () => this.dispose()
    );
  }

  current(): T {
    return this.store.current();
  }

  get cursor(): LiveCursor | undefined {
    return this.follower.cursor;
  }

  seed(snapshot: LiveSnapshot<T>): void {
    this.upstreamBase = {
      generation: snapshot.generation,
      sequence: snapshot.sequence,
    };
    this.follower.seed(snapshot);
  }

  applyUpdate(update: LiveUpdate): void {
    if (this.initialUpdates) {
      this.initialUpdates.push(update);
      return;
    }
    this.follower.applyUpdate(update);
  }

  refresh(): Promise<void> {
    return this.follower.refresh();
  }

  async snapshot(): Promise<LiveSnapshot<unknown>> {
    await this.ready;
    return {
      generation: this.localGeneration,
      sequence: this.localSequence,
      timestamp: Date.now(),
      data: structuredClone(this.store.serialize()),
    };
  }

  subscribe(cb: (update: LiveUpdate) => void): Unsubscribe {
    return this.emitter.subscribe(cb);
  }

  onChange(cb: (value: T, meta: LiveChangeMeta) => void): Unsubscribe {
    return this.changeEmitter.subscribe(({ value, meta }) => cb(value, meta));
  }

  /**
   * 上游此刻没有这份实例,或重连被拒且不会重试。`current()` 仍是最后读到的值 —— 那之前的样子,不是现在。
   * keyed 主题上副本照旧挂着,同一个 key 再建出实例时重新 seed。
   */
  onGone(cb: (error: WireError) => void): Unsubscribe {
    return this.goneEmitter.subscribe(cb);
  }

  waitForCursor(target: LiveCursor, timeoutMs = 15_000): Promise<void> {
    return this.waiters.waitForCursor(target, timeoutMs);
  }

  waitForLocalCursor(target: LiveCursor, timeoutMs = 15_000): Promise<void> {
    return this.localWaiters.waitForCursor(target, timeoutMs);
  }

  waitForMutation(mutationId: string, timeoutMs = 15_000): Promise<void> {
    return this.waiters.waitForMutation(mutationId, timeoutMs);
  }

  localCursorFor(upstream: LiveCursor): LiveCursor {
    const current = this.cursor;
    if (
      !current ||
      !this.upstreamBase ||
      current.generation !== upstream.generation ||
      this.upstreamBase.generation !== upstream.generation
    ) {
      return this.localCursor();
    }

    return {
      generation: this.localGeneration,
      sequence: Math.max(0, upstream.sequence - this.upstreamBase.sequence),
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.waiters.rejectAll(new Error('ReplicaState disposed'));
    this.localWaiters.rejectAll(new Error('ReplicaState disposed'));
    this.emitter.clear();
    this.changeEmitter.clear();
    this.goneEmitter.clear();
    await detachSettled(this.detachPromise);
  }

  private handleSeeded(): void {
    this.upstreamBase = this.cursor;
    this.localGeneration = nextGeneration(this.localGeneration);
    this.localSequence = 0;
    this.emitChange({ kind: 'seed' });
    this.waiters.flushCursorWaiters();
    this.waiters.flushAllMutationWaiters();
    this.localWaiters.flushCursorWaiters();
    if (this.initialUpdates) {
      for (const update of this.initialUpdates) {
        const cursor = this.cursor;
        if (cursor?.generation === update.generation && update.sequence <= cursor.sequence) continue;
        this.follower.applyUpdate(update);
      }
      this.initialUpdates = null;
    }
  }

  private handleApplied(update: LiveUpdate): void {
    const baseSequence = this.localSequence;
    this.localSequence += 1;
    this.emitter.emit({
      generation: this.localGeneration,
      baseSequence,
      sequence: this.localSequence,
      timestamp: update.timestamp,
      delta: update.delta,
      mutationIds: update.mutationIds,
    });
    this.emitChange({ kind: 'update', mutationIds: update.mutationIds ?? [] });
    this.waiters.flushCursorWaiters();
    this.waiters.flushMutationWaiters(update.mutationIds ?? []);
    this.localWaiters.flushCursorWaiters();
  }

  private localCursor(): LiveCursor {
    return {
      generation: this.localGeneration,
      sequence: this.localSequence,
    };
  }

  private emitChange(meta: LiveChangeMeta): void {
    const value = this.store.current();
    this.deps.onChange?.(value, meta);
    this.changeEmitter.emit({ value, meta });
  }
}

function nextGeneration(previous = 0): number {
  return Math.max(Date.now(), previous + 1);
}
