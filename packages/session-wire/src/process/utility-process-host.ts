import { Emitter, onErrorEvents, type Unsubscribe } from '@gugu/session-shared';
import { listen, type EventEmitterLike } from './events';
import { createSupervisedProcess } from './supervisor';
import type { ChildHandle, ManagedProcess, ProcessExit, ProcessHost, ProcessSpec } from './types';

export type UtilityProcessForkOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
};

export type UtilityProcessLike = EventEmitterLike & {
  readonly pid?: number;
  postMessage(message: unknown): void;
  kill(): void;
  stdout?: EventEmitterLike;
  stderr?: EventEmitterLike;
};

export type UtilityForkLike = (
  entry: string,
  args?: string[],
  options?: UtilityProcessForkOptions
) => UtilityProcessLike;

export function utilityProcessHost(deps: { fork: UtilityForkLike }): ProcessHost {
  return {
    spawn(spec, scope): Promise<ManagedProcess> {
      return createSupervisedProcess(spec, (nextSpec) => spawnUtilityChild(deps, nextSpec), scope);
    },
  };
}

function spawnUtilityChild(deps: { fork: UtilityForkLike }, spec: ProcessSpec): ChildHandle {
  const process = deps.fork(spec.entry, spec.args ?? [], { cwd: spec.cwd, env: spec.env });

  // @@@unhandled-error-event (#4942) — 与 node 那份同一处理:创建即接上,进程本体与两条输出流各是
  // 独立发射器。Electron 的 UtilityProcess 只在 V8 FatalError 时 emit 'error',但「少见」不是「不会」。
  const errorEmitter = new Emitter<Error>();
  onErrorEvents([process, process.stdout, process.stderr], (error) => errorEmitter.emit(error));

  return {
    get pid() {
      return process.pid;
    },
    send(message) {
      process.postMessage(message);
    },
    onMessage(cb): Unsubscribe {
      return listen(process, 'message', (message) => cb(message));
    },
    onExit(cb): Unsubscribe {
      return listen(process, 'exit', (code, signal) => cb(toProcessExit(code, signal)));
    },
    onStdio(cb): Unsubscribe {
      const unsubscribeStdout = listen(process.stdout, 'data', (chunk) =>
        cb('stdout', stringifyChunk(chunk))
      );
      const unsubscribeStderr = listen(process.stderr, 'data', (chunk) =>
        cb('stderr', stringifyChunk(chunk))
      );
      return () => {
        unsubscribeStdout();
        unsubscribeStderr();
      };
    },
    onError(cb): Unsubscribe {
      return errorEmitter.subscribe(cb);
    },
    kill(): void {
      process.kill();
    },
  };
}

function toProcessExit(code: unknown, signal: unknown): ProcessExit {
  return {
    code: typeof code === 'number' ? code : null,
    signal: typeof signal === 'string' ? signal : null,
  };
}

function stringifyChunk(chunk: unknown): string {
  return typeof chunk === 'string' ? chunk : String(chunk);
}
