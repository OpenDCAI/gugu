import { Emitter, type Unsubscribe } from '@gugu/session-shared';
import type { LogFields, LogLevel, Logger } from '@gugu/session-shared/logger';
import { client, type ContractClient } from '../../api/client';
import { connect, type Connection } from '../../api/connect';
import type { Controller } from '../../api/controller';
import type { Contract, ContractDefinitions } from '../../api/define';
import { isWireMessage, type WireTransport } from '../../api/protocol';
import { serve, type ServeOptions } from '../../api/serve';
import type { ValidatePolicy } from '../../api/with-validation';
import type { WireInstrumentation } from '../../observability';
import type { ManagedProcess, ProcessHost, ProcessSpec } from '../../process/types';
import { createScope, type Scope } from '../scope';

const RUNTIME_SIGNAL_KIND = 'wire-runtime-signal';
/** Shared child-runtime readiness budget; ACP initialize uses the same no-ready-signal semantics. */
export const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;

type RuntimeSignal = {
  kind: typeof RUNTIME_SIGNAL_KIND;
  event: 'ready' | 'shutdown' | 'shutdown-complete';
};

const READY_SIGNAL: RuntimeSignal = { kind: RUNTIME_SIGNAL_KIND, event: 'ready' };

export const RUNTIME_SHUTDOWN_SIGNAL: RuntimeSignal = {
  kind: RUNTIME_SIGNAL_KIND,
  event: 'shutdown',
};

export const RUNTIME_SHUTDOWN_COMPLETE_SIGNAL: RuntimeSignal = {
  kind: RUNTIME_SIGNAL_KIND,
  event: 'shutdown-complete',
};

export type SpawnRuntimeOptions<Defs extends ContractDefinitions> = {
  host: ProcessHost;
  contract: Contract<Defs>;
  spec: ProcessSpec;
  scope: Scope;
  readyTimeoutMs?: number;
  shutdownGraceMs?: number;
  instrumentation?: WireInstrumentation;
  onProcess?: (process: ManagedProcess) => void;
};

export type RuntimeHandle<Defs extends ContractDefinitions> = {
  readonly client: ContractClient<Defs>;
  readonly connection: Connection;
  readonly process: ManagedProcess;
  onRestarted(cb: () => void): Unsubscribe;
  dispose(): Promise<void>;
};

export type ProcessRuntimePort = {
  send(message: unknown): void;
  sendAndWait?(message: unknown): Promise<void>;
  onMessage(cb: (message: unknown) => void): Unsubscribe;
  onDisconnect(cb: () => void): Unsubscribe;
};

export type ServeWorkerProcessOptions = ServeOptions & {
  logger?: Logger;
  failOnCleanupError?: boolean;
  /**
   * Test seam for running the child-side helper without a real Node fork or
   * Electron utility process.
   */
  port?: ProcessRuntimePort;
  /**
   * Test seam for observing shutdown without terminating the test worker.
   */
  exit?: (code: number) => void;
};

/** @@@unhandled-error-event (#4942) — `installProcessCrashGuards` 要挂钩子的那个进程,做成可替身的。 */
export type CrashGuardTarget = {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (value: unknown) => void): unknown;
  off?(event: 'uncaughtException' | 'unhandledRejection', listener: (value: unknown) => void): unknown;
};

export type InstallProcessCrashGuardsOptions = {
  logger: Pick<Logger, 'error'>;
  exit: (code: number) => void;
  target?: CrashGuardTarget;
};

export type ForwardRuntimeLogsOptions = {
  source?: string;
};

export async function spawnRuntime<Defs extends ContractDefinitions>(
  options: SpawnRuntimeOptions<Defs>
): Promise<RuntimeHandle<Defs>> {
  const spec = withDefaultGracefulShutdown(options.spec, options.shutdownGraceMs);
  const managed = await options.host.spawn(spec);
  options.onProcess?.(managed);

  try {
    await waitForReady(managed, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  } catch (error) {
    // 没就绪才是原因:收尾再失败(如 graceful shutdown 超时,进程照样被 kill)只记一行,❌ 拿它顶掉原始错误。
    await managed.dispose().catch((disposeError: unknown) => {
      options.scope.log.warn('runtime cleanup after a failed start failed', { error: disposeError });
    });
    throw error;
  }

  const restartedEmitter = new Emitter<void>();
  const reconnectListeners = new Set<() => void>();
  const unsubscribeReady = managed.onMessage((message) => {
    if (!isRuntimeSignal(message, 'ready')) return;
    for (const cb of reconnectListeners) cb();
    restartedEmitter.emit();
  });

  const transport = createRuntimeTransport(
    {
      send: (message) => managed.send(message),
      onMessage: (cb) => managed.onMessage(cb),
      onDisconnect: (cb) => managed.onExit(() => cb()),
    },
    {
      onReconnect(cb) {
        reconnectListeners.add(cb);
        return () => reconnectListeners.delete(cb);
      },
    }
  );

  const connection = connect(transport, { instrumentation: options.instrumentation });
  const runtimeClient = client(options.contract, connection);

  let disposePromise: Promise<void> | undefined;
  const handle: RuntimeHandle<Defs> = {
    client: runtimeClient,
    connection,
    process: managed,
    onRestarted(cb) {
      return restartedEmitter.subscribe(cb);
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposePromise = (async () => {
        unsubscribeReady();
        restartedEmitter.clear();
        reconnectListeners.clear();
        await managed.dispose();
      })();
      return disposePromise;
    },
  };

  options.scope.use(handle);
  return handle;
}

export async function serveWorkerProcess(
  init: (scope: Scope) => Controller | Promise<Controller>,
  options: ServeWorkerProcessOptions = {}
): Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const cleanupErrors: unknown[] = [];
  const scope = createScope({
    label: 'worker-process',
    logger: options.logger,
    ...(options.failOnCleanupError
      ? {
          onCleanupError(error, context) {
            cleanupErrors.push(error);
            context.logger.error('worker process cleanup failed', {
              label: context.label,
              labelPath: context.labelPath,
              error,
            });
          },
        }
      : {}),
  });
  const logger = options.logger ?? scope.log;
  const port =
    options.port ??
    resolveParentPort((error) => {
      logger.error('worker process failed to post a message to its parent', {
        error: error.message,
      });
    });
  let exiting = false;

  const transport = createRuntimeTransport(port);

  const shutdown = async (code: number): Promise<void> => {
    if (exiting) return;
    exiting = true;
    await scope.dispose();
    if (cleanupErrors.length > 0) {
      exit(1);
      return;
    }
    if (port.sendAndWait) {
      await port.sendAndWait(RUNTIME_SHUTDOWN_COMPLETE_SIGNAL);
    } else {
      port.send(RUNTIME_SHUTDOWN_COMPLETE_SIGNAL);
    }
    logger.info('worker process shutdown complete');
    exit(code);
  };

  // @@@unhandled-error-event (#4942) — `shutdown` 是 async 且**真的会 reject**:它内部 `await
  // port.sendAndWait(RUNTIME_SHUTDOWN_COMPLETE_SIGNAL)`,而这一步失败的典型时机恰好就是父进程已经没了 ——
  // 也正是下面 onDisconnect 触发的那一刻。原来两处写的是裸 `void shutdown(0)`:promise 一 reject 就是
  // 未处理拒绝,Node 15+ 默认把它抛成未捕获异常,worker 于是**崩着退出**而不是干净收尾,父进程读到的是
  // 一个看不懂的非零退出码。❌ 不是吞:错误照旧记到日志,再按失败码退出。
  const shutdownOrCrash = (code: number): void => {
    void shutdown(code).catch((error: unknown) => {
      logger.error('worker process shutdown failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      exit(1);
    });
  };

  scope.add(
    port.onMessage((message) => {
      if (isRuntimeSignal(message, 'shutdown')) shutdownOrCrash(0);
    })
  );
  scope.add(port.onDisconnect(() => shutdownOrCrash(0)));

  // 传了 port 说明是测试替身(见上面 options.port 的注释),那时别去动真 process 的全局钩子。
  if (!options.port) {
    scope.add(installProcessCrashGuards({ logger, exit }));
  }

  try {
    const controller = await init(scope);
    scope.add(() => controller.dispose?.());
    scope.add(serve(transport, controller, options));
    port.send(READY_SIGNAL);
  } catch (error) {
    await scope.dispose();
    logger.error('worker process failed to start', {
      error: error instanceof Error ? error.message : String(error),
    });
    exit(1);
  }
}

/**
 * @@@unhandled-error-event (#4942) — worker 进程的顶层保护。
 *
 * 这些 worker 是 fork 出来的裸 node 进程,自己没有任何 `process.on` 处理器:一次未捕获异常、或一次没人
 * 接的 promise 拒绝(Node 15+ 默认 `--unhandled-rejections=throw`),进程就**无声无息地没了**,父进程只看到
 * 一个退出码,日志里一个字都没有 —— 这正是排查 #4935 时最费时间的那一段。
 *
 * ❌ 这不是「让它活下去」:该死照旧死(exit 非零)。它买的是**死之前留下一句话**。
 */
export function installProcessCrashGuards(
  options: InstallProcessCrashGuardsOptions
): Unsubscribe {
  const target = options.target ?? (process as unknown as CrashGuardTarget);
  const onUncaught = (error: unknown): void => {
    options.logger.error('worker process uncaught exception', {
      error: error instanceof Error ? error.message : String(error),
    });
    options.exit(1);
  };
  const onRejection = (reason: unknown): void => {
    options.logger.error('worker process unhandled rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
    options.exit(1);
  };

  target.on('uncaughtException', onUncaught);
  target.on('unhandledRejection', onRejection);
  return () => {
    target.off?.('uncaughtException', onUncaught);
    target.off?.('unhandledRejection', onRejection);
  };
}

export function workerValidatePolicy(env: NodeJS.ProcessEnv = process.env): ValidatePolicy {
  return env.NODE_ENV === 'production' ? 'inputs' : 'full';
}

export function forwardRuntimeLogs(
  process: ManagedProcess,
  logger: Logger,
  options: ForwardRuntimeLogsOptions = {}
): Unsubscribe {
  let stderrBuffer = '';
  const unsubscribeStdio = process.onStdio((stream, chunk) => {
    if (stream === 'stdout') {
      logger.debug('runtime stdout', { source: options.source, chunk });
      return;
    }

    stderrBuffer += chunk;
    let newline = stderrBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = stderrBuffer.slice(0, newline);
      stderrBuffer = stderrBuffer.slice(newline + 1);
      forwardRuntimeLogLine(logger, line, options);
      newline = stderrBuffer.indexOf('\n');
    }
  });
  const unsubscribeExit = process.onExit(() => {
    if (stderrBuffer.trim()) forwardRuntimeLogLine(logger, stderrBuffer, options);
    stderrBuffer = '';
  });

  return () => {
    unsubscribeStdio();
    unsubscribeExit();
  };
}

function createRuntimeTransport(
  port: ProcessRuntimePort,
  options: Pick<WireTransport, 'onReconnect'> = {}
): WireTransport {
  return {
    post(message) {
      port.send(message);
    },
    onMessage(cb) {
      return port.onMessage((message) => {
        if (isWireMessage(message)) cb(message);
      });
    },
    onDisconnect(cb) {
      return port.onDisconnect(cb);
    },
    onReconnect: options.onReconnect,
  };
}

function withDefaultGracefulShutdown(spec: ProcessSpec, graceMs?: number): ProcessSpec {
  if (spec.gracefulShutdown) return spec;
  return {
    ...spec,
    gracefulShutdown: {
      message: RUNTIME_SHUTDOWN_SIGNAL,
      graceMs: graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
    },
  };
}

function forwardRuntimeLogLine(
  logger: Logger,
  line: string,
  options: ForwardRuntimeLogsOptions
): void {
  if (!line.trim()) return;

  const parsed = parseRuntimeLogLine(line);
  if (!parsed) {
    logger.warn('runtime stderr', { source: options.source, chunk: line });
    return;
  }

  const { level, message, fields } = parsed;
  logger[level](message, { source: options.source, ...fields });
}

function parseRuntimeLogLine(
  line: string
): { level: LogLevel; message: string; fields: LogFields } | null {
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    const level = parseRuntimeLogLevel(record.level);
    if (!level) return null;
    const message = typeof record.msg === 'string' ? record.msg : 'runtime log';
    const fields: LogFields = { ...record };
    delete fields.level;
    delete fields.msg;
    return { level, message, fields };
  } catch {
    return null;
  }
}

function parseRuntimeLogLevel(value: unknown): LogLevel | null {
  if (value === 'debug' || value === 20) return 'debug';
  if (value === 'info' || value === 30) return 'info';
  if (value === 'warn' || value === 40) return 'warn';
  if (value === 'error' || value === 50 || value === 60) return 'error';
  return null;
}

function waitForReady(managed: ManagedProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Runtime did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);

    const unsubscribeMessage = managed.onMessage((message) => {
      if (!isRuntimeSignal(message, 'ready')) return;
      cleanup();
      resolve();
    });
    const unsubscribeExit = managed.onExit((exit) => {
      if (exit.willRestart) return;
      cleanup();
      reject(new Error(`Runtime exited before ready (code ${exit.code})`));
    });

    function cleanup(): void {
      clearTimeout(timer);
      unsubscribeMessage();
      unsubscribeExit();
    }
  });
}

function isRuntimeSignal(
  message: unknown,
  event: RuntimeSignal['event']
): message is RuntimeSignal {
  if (typeof message !== 'object' || message === null) return false;
  const record = message as Record<string, unknown>;
  return record.kind === RUNTIME_SIGNAL_KIND && record.event === event;
}

function resolveParentPort(onSendError: (error: Error) => void): ProcessRuntimePort {
  if (typeof process === 'undefined') {
    throw new Error('serveWorkerProcess requires an IPC channel to the parent process');
  }

  // @@@task-fusion (#2802) — electron 的全局类型增强会让 NodeJS.Process 的 on/off 只暴露
  // 'loaded' 重载,而这里注册的是 fork worker 的标准 node 事件(message/disconnect)。
  // 按结构类型声明这两个方法,既拿回类型检查又不受宿主 electron 版本影响。
  const currentProcess = process as NodeJS.Process & {
    on(event: string, listener: (...args: never[]) => void): void;
    off(event: string, listener: (...args: never[]) => void): void;
    parentPort?: {
      postMessage(message: unknown): void;
      on(event: 'message', cb: (event: { data: unknown }) => void): void;
      off(event: 'message', cb: (event: { data: unknown }) => void): void;
    };
  };

  if (currentProcess.parentPort) {
    const parentPort = currentProcess.parentPort;
    return {
      send(message) {
        parentPort.postMessage(message);
      },
      async sendAndWait(message) {
        parentPort.postMessage(message);
      },
      onMessage(cb) {
        const listener = (event: { data: unknown }): void => cb(event.data);
        parentPort.on('message', listener);
        return () => parentPort.off('message', listener);
      },
      onDisconnect() {
        return () => {};
      },
    };
  }

  if (typeof currentProcess.send !== 'function') {
    throw new Error('serveWorkerProcess requires an IPC channel to the parent process');
  }

  return {
    // @@@unhandled-error-event (#4942) — `process.send()` 不带回调时,发送失败(管道已关 = 父进程没了)
    // 由 Node **异步地**变成 process 上的 'error' 事件;零监听者就是未捕获异常。带上回调就把这条失败
    // 收进正常返回值里 —— ❌ 不是吞错:调用方本来就把这次发送当作 best-effort(要等确认的走 sendAndWait)。
    send(message) {
      currentProcess.send?.(
        message as Parameters<NonNullable<NodeJS.Process['send']>>[0],
        (error: Error | null) => {
          if (error) onSendError(error);
        }
      );
    },
    sendAndWait(message) {
      return new Promise<void>((resolve, reject) => {
        const send = currentProcess.send as (
          message: unknown,
          callback: (error: Error | null) => void
        ) => boolean;
        try {
          send.call(currentProcess, message, (error) => {
            if (error) reject(error);
            else resolve();
          });
        } catch (error) {
          reject(error);
        }
      });
    },
    onMessage(cb) {
      currentProcess.on('message', cb as never);
      return () => currentProcess.off('message', cb as never);
    },
    onDisconnect(cb) {
      currentProcess.on('disconnect', cb as never);
      return () => currentProcess.off('disconnect', cb as never);
    },
  };
}
