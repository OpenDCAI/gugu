import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Emitter, type Unsubscribe } from '@gugu/session-shared';
import type {
  ManagedProcess,
  ManagedProcessExit,
  ProcessHost,
  ProcessSpec,
  StdioStream,
} from '@gugu/session-wire/process';
import { serveWorkerProcess, type ProcessRuntimePort } from '@gugu/session-wire/util/process-runtime';
import { describe, expect, it } from 'vitest';
import { awaitPending } from '../../../../../../tests/support/awaitFact';
import type { IWatchService, WatchEvent, WatchHandle, WatchOptions } from '../api';
import { createFsWatchController } from './controller';
import { processWatchBackend } from './process-backend';
import { createWatchService } from './watch-service';

describe('processWatchBackend', () => {
  it('delivers child events, dedupes same-key consumers, and unwatches on release', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'emdash-fs-watch-process-'));
    const host = new FakeProcessHost();
    const backend = processWatchBackend({ entry: 'worker', host });
    const service = createWatchService({ backend });
    const signal = callbackSignal();
    const childService = new ManualWatchService({ onChange: signal.notify });
    const firstEvents: WatchEvent[] = [];
    const secondEvents: WatchEvent[] = [];

    try {
      const first = service.watch(root, (events) => {
        firstEvents.push(...events);
        signal.notify();
      });
      await Promise.resolve();
      await startChild(host.process(), childService);
      await first.ready();
      const second = service.watch(root, (events) => {
        secondEvents.push(...events);
        signal.notify();
      });
      await second.ready();

      expect(childService.watchCount).toBe(1);
      childService.emit([{ kind: 'create', path: path.join(root, 'created.txt') }]);
      await signal.until(
        'both consumers receive the child event',
        () => firstEvents.length >= 1 && secondEvents.length >= 1
      );
      expect(firstEvents).toHaveLength(1);
      expect(secondEvents).toHaveLength(1);

      await first.release();
      expect(childService.releaseCount).toBe(0);
      await second.release();
      await signal.until('child unwatches after the last release', () => childService.releaseCount >= 1);
      expect(childService.releaseCount).toBe(1);
    } finally {
      await service.dispose();
    }
  });

  // key 的每个维度都必须原样过界。recursive 漏传时子进程按默认值 recursive=true 订阅:调用方
  // 拿到的 handle 一切正常,单层监听却在整根递归 —— 桌面出货正是走这条 worker 路径,所以这条
  // 判据看的是「子进程真收到了什么」,不是「父进程发了什么」。
  it('carries every watch-key dimension across the process boundary', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'emdash-fs-watch-recursive-'));
    const host = new FakeProcessHost();
    const backend = processWatchBackend({ entry: 'worker', host });
    const service = createWatchService({ backend });
    const childService = new ManualWatchService();

    try {
      const shallow = service.watch(root, () => {}, { recursive: false, ignore: ['dist/**'] });
      await Promise.resolve();
      await startChild(host.process(), childService);
      await shallow.ready();
      expect(childService.seenOptions.at(-1)?.recursive).toBe(false);
      expect(childService.seenOptions.at(-1)?.ignore).toEqual(['dist/**']);

      const deep = service.watch(root, () => {}, { recursive: true, ignore: ['dist/**'] });
      await deep.ready();
      expect(childService.watchCount, '递归与单层是两个不同的 key,不能复用同一个子订阅').toBe(2);
      expect(childService.seenOptions.at(-1)?.recursive).toBe(true);
    } finally {
      await service.dispose();
    }
  });

  it('reattaches active watches and signals resync after child restart', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'emdash-fs-watch-restart-'));
    const host = new FakeProcessHost();
    const backend = processWatchBackend({ entry: 'worker', host });
    const service = createWatchService({ backend });
    const signal = callbackSignal();
    const firstChildService = new ManualWatchService();
    const events: WatchEvent[] = [];
    let resyncs = 0;

    try {
      const handle = service.watch(
        root,
        (batch) => {
          events.push(...batch);
          signal.notify();
        },
        {
          onResync: () => {
            resyncs += 1;
            signal.notify();
          },
        }
      );
      await Promise.resolve();
      await startChild(host.process(), firstChildService);
      await handle.ready();

      const restartedChildService = new ManualWatchService({ onChange: signal.notify });
      host.process().emitExit({ code: 1, willRestart: true });
      await startChild(host.process(), restartedChildService);

      await signal.until('restarted child re-subscribes', () => restartedChildService.watchCount >= 1);
      await signal.until('consumer is told to resync', () => resyncs >= 1);
      expect(restartedChildService.watchCount).toBe(1);

      restartedChildService.emit([{ kind: 'update', path: path.join(root, 'after-restart.txt') }]);
      await signal.until('event from the restarted child arrives', () => events.length >= 1);
      expect(events).toHaveLength(1);

      expect(resyncs).toBe(1);
      await handle.release();
    } finally {
      await service.dispose();
    }
  });

  it('rejects ready when the child watcher fails to start', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'emdash-fs-watch-failure-'));
    const host = new FakeProcessHost();
    const backend = processWatchBackend({ entry: 'worker', host });
    const service = createWatchService({ backend });
    const signal = callbackSignal();
    const childService = new ManualWatchService({
      readyError: new Error('watch failed'),
      onChange: signal.notify,
    });

    try {
      const handle = service.watch(root, () => {});
      await Promise.resolve();
      await startChild(host.process(), childService);

      await expect(handle.ready()).rejects.toThrow('watch failed');
      await signal.until('failed child watch is released', () => childService.releaseCount >= 1);
      expect(childService.releaseCount).toBe(1);
    } finally {
      await service.dispose();
    }
  });

  it('surfaces terminal reattach errors from the child worker', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'emdash-fs-watch-reattach-error-'));
    const host = new FakeProcessHost();
    const errors: Array<{ context: string; message: string }> = [];
    const signal = callbackSignal();
    const backend = processWatchBackend({
      entry: 'worker',
      host,
      onError: (context, error) => {
        errors.push({
          context,
          message: error instanceof Error ? error.message : String(error),
        });
        signal.notify();
      },
    });
    const service = createWatchService({ backend });
    const childService = new ManualWatchService();

    try {
      const handle = service.watch(root, () => {});
      await Promise.resolve();
      await startChild(host.process(), childService);
      await handle.ready();

      host.process().emitExit({ code: 1, willRestart: true });
      await startBrokenChild(host.process());

      await signal.until('terminal reattach error is reported', () =>
        errors.some((error) => error.context.includes('reattach terminal'))
      );
      expect(errors).toContainEqual({
        context: expect.stringContaining('reattach terminal'),
        message: expect.stringContaining('Unknown live topic'),
      });

      await handle.release();
    } finally {
      await service.dispose();
    }
  });
});

async function startChild(process: FakeManagedProcess, service: IWatchService): Promise<void> {
  await serveWorkerProcess(
    (scope) =>
      createFsWatchController({
        scope,
        service,
      }),
    {
      port: process.createChildPort(),
      exit: (code) => process.emitExit({ code, willRestart: false }),
    }
  );
}

async function startBrokenChild(process: FakeManagedProcess): Promise<void> {
  await serveWorkerProcess(
    () => ({
      call: () => {
        throw new Error('not implemented');
      },
      resolveLive: () => null,
    }),
    {
      port: process.createChildPort(),
      exit: (code) => process.emitExit({ code, willRestart: false }),
    }
  );
}

/**
 * 等回调交出的事实:被测代码的回调(watch 回调、onResync、onError、子进程侧的 watch / release)
 * 每来一次就 `notify()`,`until` 在那一刻重判条件 —— 等的是回调本身,❌ 5s 期限的轮询。
 */
function callbackSignal() {
  const waiters = new Set<{ holds: () => boolean; resolve: () => void }>();
  return {
    notify: (): void => {
      for (const waiter of [...waiters]) {
        if (!waiter.holds()) continue;
        waiters.delete(waiter);
        waiter.resolve();
      }
    },
    until: (step: string, holds: () => boolean): Promise<void> =>
      holds()
        ? Promise.resolve()
        : awaitPending(step, new Promise<void>((resolve) => waiters.add({ holds, resolve }))),
  };
}

class ManualWatchService implements IWatchService {
  async nudge(): Promise<boolean> {
    return false;
  }
  watchCount = 0;
  releaseCount = 0;
  readonly seenOptions: WatchOptions[] = [];
  private current:
    | {
        onEvents: (events: WatchEvent[]) => void;
        onResync?: () => void;
        released: boolean;
      }
    | undefined;

  constructor(private readonly options: { readyError?: Error; onChange?: () => void } = {}) {}

  watch(
    _root: string,
    onEvents: (events: WatchEvent[]) => void,
    options: WatchOptions = {}
  ): WatchHandle {
    this.watchCount += 1;
    this.seenOptions.push(options);
    const current = { onEvents, onResync: options.onResync, released: false };
    this.current = current;
    this.options.onChange?.();
    return {
      ready: async () => {
        if (this.options.readyError) throw this.options.readyError;
      },
      release: async () => {
        if (current.released) return;
        current.released = true;
        this.releaseCount += 1;
        if (this.current === current) this.current = undefined;
        this.options.onChange?.();
      },
    };
  }

  emit(events: WatchEvent[]): void {
    this.current?.onEvents(events);
  }

  async dispose(): Promise<void> {
    this.current = undefined;
  }
}

class FakeProcessHost implements ProcessHost {
  private spawned: FakeManagedProcess | undefined;

  async spawn(spec: ProcessSpec): Promise<ManagedProcess> {
    this.spawned = new FakeManagedProcess(spec);
    return this.spawned;
  }

  process(): FakeManagedProcess {
    if (!this.spawned) throw new Error('No process spawned');
    return this.spawned;
  }
}

class FakeManagedProcess implements ManagedProcess {
  readonly sentMessages: unknown[] = [];
  disposed = false;
  readonly pid = 1;
  private readonly parentMessages = new Emitter<unknown>();
  private readonly exitEmitter = new Emitter<ManagedProcessExit>();
  private readonly errorEmitter = new Emitter<Error>();
  private readonly stdioEmitter = new Emitter<{ stream: StdioStream; chunk: string }>();
  private childMessages: Emitter<unknown> | undefined;
  private disposePromise: Promise<void> | undefined;
  private exited = false;

  constructor(readonly spec: ProcessSpec) {}

  send(message: unknown): void {
    this.sentMessages.push(message);
    this.childMessages?.emit(message);
  }

  onMessage(cb: (message: unknown) => void): Unsubscribe {
    return this.parentMessages.subscribe(cb);
  }

  onExit(cb: (exit: ManagedProcessExit) => void): Unsubscribe {
    return this.exitEmitter.subscribe(cb);
  }

  // @@@unhandled-error-event (#4942) — 进程契约要求有一条错误出口。这里给的是真发射器而不是空壳:
  // 用例要造「发送失败」时,emitError 就是那个入口。
  onError(cb: (error: Error) => void): Unsubscribe {
    return this.errorEmitter.subscribe(cb);
  }

  emitError(error: Error): void {
    this.errorEmitter.emit(error);
  }

  onStdio(cb: (stream: StdioStream, chunk: string) => void): Unsubscribe {
    return this.stdioEmitter.subscribe(({ stream, chunk }) => cb(stream, chunk));
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      if (this.spec.gracefulShutdown?.message !== undefined) {
        this.send(this.spec.gracefulShutdown.message);
        await Promise.resolve();
        await Promise.resolve();
      }
      if (!this.exited) this.emitExit({ code: null, willRestart: false });
    })();
    return this.disposePromise;
  }

  createChildPort(): ProcessRuntimePort {
    this.exited = false;
    const childMessages = new Emitter<unknown>();
    this.childMessages = childMessages;
    return {
      send: (message) => this.parentMessages.emit(message),
      onMessage: (cb) => childMessages.subscribe(cb),
      onDisconnect: () => () => {},
    };
  }

  emitExit(exit: ManagedProcessExit): void {
    this.exited = true;
    this.exitEmitter.emit(exit);
  }
}
