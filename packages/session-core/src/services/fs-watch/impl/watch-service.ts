import { Emitter } from '@gugu/session-shared';
import { createManagedSource, createScope, type Scope } from '@gugu/session-wire/util';
import type { IWatchService, WatchEvent } from '../api';
import type { WatchBackend, WatchKey, WatchOnError } from './backend';
import { realpathOrResolve } from './paths';

export type CreateWatchServiceOptions = {
  backend: WatchBackend;
  scope?: Scope;
  graceMs?: number;
  onError?: WatchOnError;
};

type WatchChannel = {
  events: Emitter<WatchEvent[]>;
  resync: Emitter<void>;
};

export function createWatchService(options: CreateWatchServiceOptions): IWatchService {
  const serviceScope = options.scope
    ? options.scope.child('fs-watch-service')
    : createScope({ label: 'fs-watch-service' });
  const consumers = new Set<Scope>();
  let disposed = false;

  const channels = createManagedSource<WatchKey, WatchChannel>({
    key: watchKey,
    scope: serviceScope,
    label: 'channels',
    graceMs: options.graceMs ?? 0,
    onError: (error, key) => options.onError?.(`watch ${key}`, error),
    create: async (key, scope) => {
      const events = new Emitter<WatchEvent[]>();
      const resync = new Emitter<void>();
      scope.add(() => {
        events.clear();
        resync.clear();
      });
      await options.backend.subscribe(
        key,
        {
          events: (batch) => events.emit(batch),
          resync: () => resync.emit(),
        },
        scope
      );
      return { events, resync };
    },
  });

  return {
    watch(root, onEvents, watchOptions = {}) {
      if (disposed || serviceScope.disposed) throw new Error('FsWatchService disposed');

      const key = normalizeWatchKey(root, watchOptions.ignore, watchOptions.recursive ?? true, watchOptions.coarse ?? false);
      const lease = channels.acquire(key);
      const consumerScope = serviceScope.child('consumer');
      consumers.add(consumerScope);
      consumerScope.add(() => {
        consumers.delete(consumerScope);
      });

      let released = false;
      const ready = lease.ready().then((channel) => {
        if (released || consumerScope.disposed) return;
        consumerScope.add(
          channel.events.subscribe(
            withDebounce(onEvents, watchOptions.debounceMs ?? 0, consumerScope)
          )
        );
        if (watchOptions.onResync)
          consumerScope.add(channel.resync.subscribe(watchOptions.onResync));
      });

      return {
        ready: () => ready,
        release: async () => {
          if (released) return;
          released = true;
          await consumerScope.dispose();
          await lease.release();
        },
      };
    },
    async nudge(root) {
      if (disposed) return false;
      return (await options.backend.nudge?.(root === undefined ? undefined : realpathOrResolve(root))) ?? false;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const activeConsumers = [...consumers];
      consumers.clear();
      await Promise.allSettled(activeConsumers.map((consumer) => consumer.dispose()));
      await channels.dispose();
      await options.backend.dispose?.();
      await serviceScope.dispose();
    },
  };
}

function normalizeWatchKey(
  root: string,
  ignore: string[] | undefined,
  recursive: boolean,
  coarse: boolean
): WatchKey {
  return {
    root: realpathOrResolve(root),
    ignore: [...(ignore ?? [])].sort(),
    recursive,
    // 单层订阅没有「粗粒度」可言:归一成 false,免得同一个目录开出两个句柄。
    coarse: recursive && coarse,
  };
}

function watchKey(key: WatchKey): string {
  return JSON.stringify(key);
}

function withDebounce(
  onEvents: (events: WatchEvent[]) => void,
  debounceMs: number,
  scope: Scope
): (events: WatchEvent[]) => void {
  if (debounceMs <= 0) return onEvents;

  let pending: WatchEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = [];
  };
  scope.add(clear);

  return (events) => {
    pending.push(...events);
    if (timer) return;

    timer = setTimeout(() => {
      timer = null;
      const batch = pending;
      pending = [];
      if (batch.length > 0) onEvents(batch);
    }, debounceMs);
  };
}
