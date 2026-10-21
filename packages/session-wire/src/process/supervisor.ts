import { Emitter, type Unsubscribe } from '@gugu/session-shared';
import { createScope, type Scope } from '../util';
import type {
  ChildHandle,
  ManagedProcess,
  ManagedProcessExit,
  ProcessExit,
  ProcessSpec,
  SpawnChild,
  StdioStream,
} from './types';

type CurrentChild = {
  handle: ChildHandle;
  scope: Scope;
};

export async function createSupervisedProcess(
  spec: ProcessSpec,
  spawnChild: SpawnChild,
  parentScope?: Scope
): Promise<ManagedProcess> {
  const process = new SupervisedProcess(spec, spawnChild);
  await process.start();
  parentScope?.use(process);
  return process;
}

class SupervisedProcess implements ManagedProcess {
  private readonly scope: Scope;
  private readonly messageEmitter = new Emitter<unknown>();
  private readonly exitEmitter = new Emitter<ManagedProcessExit>();
  private readonly stdioEmitter = new Emitter<{ stream: StdioStream; chunk: string }>();
  // @@@unhandled-error-event (#4942) — 子进程/管道错误的去处。没有它时这些错误只剩「无监听者 ⇒ 抛」
  // 一条路,而那条路杀的是宿主,不是这个子进程。
  private readonly errorEmitter = new Emitter<Error>();
  private current: CurrentChild | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private restartAttempts = 0;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(
    private readonly spec: ProcessSpec,
    private readonly spawnChild: SpawnChild
  ) {
    this.scope = createScope({ label: `process:${spec.entry}` });
  }

  get pid(): number | undefined {
    return this.current?.handle.pid;
  }

  async start(): Promise<void> {
    await this.spawnAttempt();
  }

  send(message: unknown): void {
    const child = this.current?.handle;
    if (!child) throw new Error('Managed process is not running');
    child.send(message);
  }

  onMessage(cb: (message: unknown) => void): Unsubscribe {
    return this.messageEmitter.subscribe(cb);
  }

  onExit(cb: (exit: ManagedProcessExit) => void): Unsubscribe {
    return this.exitEmitter.subscribe(cb);
  }

  onError(cb: (error: Error) => void): Unsubscribe {
    return this.errorEmitter.subscribe(cb);
  }

  private emitError(error: unknown): void {
    this.errorEmitter.emit(error instanceof Error ? error : new Error(String(error)));
  }

  onStdio(cb: (stream: StdioStream, chunk: string) => void): Unsubscribe {
    return this.stdioEmitter.subscribe(({ stream, chunk }) => cb(stream, chunk));
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.disposeAll();
    return this.disposePromise;
  }

  private async spawnAttempt(): Promise<void> {
    if (this.disposed) return;
    const attemptScope = this.scope.child('attempt');
    const handle = await this.spawnChild(this.spec, attemptScope);
    if (this.disposed) {
      await attemptScope.dispose();
      await handle.kill();
      return;
    }

    this.current = { handle, scope: attemptScope };
    attemptScope.add(handle.onMessage((message) => this.messageEmitter.emit(message)));
    attemptScope.add(handle.onStdio((stream, chunk) => this.stdioEmitter.emit({ stream, chunk })));
    attemptScope.add(handle.onError((error) => this.errorEmitter.emit(error)));
    attemptScope.add(
      handle.onExit((exit) => {
        // handleExit 里有 await;它 reject 会逃成 unhandledRejection(worker 进程里那是致命的,
        // 主进程里则留下「活着但半死」)。收进 errorEmitter,让失败有归属。
        void this.handleExit(handle, exit).catch((error: unknown) => this.emitError(error));
      })
    );
  }

  private async handleExit(handle: ChildHandle, exit: ProcessExit): Promise<void> {
    const current = this.current;
    if (!current || current.handle !== handle) return;
    this.current = undefined;
    await current.scope.dispose();

    const willRestart = this.shouldRestart(exit);
    this.exitEmitter.emit({ ...exit, willRestart });
    if (willRestart) this.scheduleRestart();
  }

  private shouldRestart(exit: ProcessExit): boolean {
    if (this.disposed) return false;
    const supervision = this.spec.supervision ?? { restart: 'never' as const };
    if (supervision.restart !== 'on-failure') return false;
    const failed = exit.code !== 0 || exit.signal != null;
    if (!failed) return false;
    return supervision.maxRestarts === undefined || this.restartAttempts < supervision.maxRestarts;
  }

  private scheduleRestart(): void {
    const supervision = this.spec.supervision;
    if (!supervision || supervision.restart !== 'on-failure') return;
    const backoffMs = supervision.backoffMs ?? [0];
    const delay = backoffMs[Math.min(this.restartAttempts, backoffMs.length - 1)] ?? 0;
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      // 同上:重启失败(spawn 抛)不能变成无人认领的 rejection。
      void this.spawnAttempt().catch((error: unknown) => this.emitError(error));
    }, delay);
  }

  private async disposeAll(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }

    let shutdownError: unknown;
    try {
      await this.stopCurrentChild();
    } catch (error) {
      shutdownError = error;
    }

    await this.scope.dispose();
    this.messageEmitter.clear();
    this.exitEmitter.clear();
    this.stdioEmitter.clear();
    if (shutdownError) throw shutdownError;
  }

  private async stopCurrentChild(): Promise<void> {
    const current = this.current;
    if (!current) return;
    const handle = current.handle;
    const exitPromise = new Promise<ProcessExit>((resolve) => {
      const unsubscribe = handle.onExit((exit) => {
        unsubscribe();
        resolve(exit);
      });
    });

    const graceful = this.spec.gracefulShutdown;
    if (graceful?.message !== undefined) {
      try {
        // ⚠️ 这圈 try 只接得住**同步**抛出。`send` 的异步失败(EPIPE 等)现在走 handle.onError,
        // ❌ 别再把这圈 catch 读成「发送失败已处理」——#4942 之前它一次也没接住过。
        handle.send(graceful.message);
      } catch (error) {
        await handle.kill();
        throw new Error(`Failed to request graceful shutdown for ${this.spec.entry}`, {
          cause: error,
        });
      }

      const result = await waitForExitOrTimeout(exitPromise, graceful.graceMs);
      if (result.kind === 'timeout') {
        await handle.kill();
        throw new Error(
          `Graceful shutdown timed out after ${graceful.graceMs}ms for ${this.spec.entry}`
        );
      }
      if (result.exit.code !== 0 || result.exit.signal) {
        throw new Error(
          `Graceful shutdown failed for ${this.spec.entry} ` +
            `(code ${String(result.exit.code)}, signal ${String(result.exit.signal ?? 'none')})`
        );
      }
      return;
    }

    if (this.current?.handle === handle) {
      await handle.kill();
    }
  }
}

async function waitForExitOrTimeout(
  exitPromise: Promise<ProcessExit>,
  ms: number
): Promise<{ kind: 'exit'; exit: ProcessExit } | { kind: 'timeout' }> {
  if (ms <= 0) return { kind: 'timeout' };
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
    void exitPromise.then((exit) => {
      clearTimeout(timer);
      resolve({ kind: 'exit', exit });
    });
  });
}
