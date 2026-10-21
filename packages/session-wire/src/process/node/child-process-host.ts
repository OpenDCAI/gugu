import { fork, type ChildProcess } from 'node:child_process';
import { Emitter, onErrorEvents, type Unsubscribe } from '@gugu/session-shared';
import type { Scope } from '../../util';
import { listen, type EventEmitterLike } from '../events';
import { createSupervisedProcess } from '../supervisor';
import type { ChildHandle, ManagedProcess, ProcessExit, ProcessHost, ProcessSpec } from '../types';

export function childProcessHost(): ProcessHost {
  return {
    spawn(spec, scope): Promise<ManagedProcess> {
      return createSupervisedProcess(spec, spawnChildProcess, scope);
    },
  };
}

function spawnChildProcess(spec: ProcessSpec, _scope: Scope): ChildHandle {
  const child = fork(spec.entry, spec.args ?? [], {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    // Structured-clone (V8) serialization preserves `undefined` values, typed
    // arrays, and Dates across the IPC channel, matching the semantics wire
    // payloads were designed for. The default JSON mode drops `undefined`
    // object properties, which breaks Result<void> payloads.
    serialization: 'advanced',
  });

  // @@@unhandled-error-event (#4942) — 在**创建那一刻**就接上,不能等订阅者出现:Node 对没有监听者的
  // 'error' 一视同仁地抛,而抛出发生在订阅之前就已经太晚。四个是**独立**的发射器 —— 只接进程本体
  // 拦不住 stdin 的 EPIPE(实测:teardown 期给已死子进程发消息,整个宿主被带走)。
  const errorEmitter = new Emitter<Error>();
  onErrorEvents([child, child.stdin, child.stdout, child.stderr], (error) =>
    errorEmitter.emit(error)
  );

  return {
    get pid() {
      return child.pid;
    },
    send(message) {
      // ⚠️ 传 callback 是**语义差别**不是风格:不传时 Node 把失败异步 emit 成 'error' 事件(于是调用点
      // 那圈 try/catch 接不住);传了就走这里,失败在本函数内被交代掉。两条路都汇进 errorEmitter。
      child.send(message as Parameters<ChildProcess['send']>[0], (error) => {
        if (error) errorEmitter.emit(error);
      });
    },
    onMessage(cb): Unsubscribe {
      return listen(child as unknown as EventEmitterLike, 'message', (message) => cb(message));
    },
    onExit(cb): Unsubscribe {
      return listen(child as unknown as EventEmitterLike, 'exit', (code, signal) =>
        cb(toProcessExit(code, signal))
      );
    },
    onStdio(cb): Unsubscribe {
      return listenToStdio(child, cb);
    },
    onError(cb): Unsubscribe {
      return errorEmitter.subscribe(cb);
    },
    kill(): void {
      child.kill('SIGKILL');
    },
  };
}

function listenToStdio(
  child: ChildProcess,
  cb: (stream: 'stdout' | 'stderr', chunk: string) => void
): Unsubscribe {
  const unsubscribeStdout = listen(
    child.stdout as unknown as EventEmitterLike | undefined,
    'data',
    (chunk) => cb('stdout', stringifyChunk(chunk))
  );
  const unsubscribeStderr = listen(
    child.stderr as unknown as EventEmitterLike | undefined,
    'data',
    (chunk) => cb('stderr', stringifyChunk(chunk))
  );
  return () => {
    unsubscribeStdout();
    unsubscribeStderr();
  };
}

function toProcessExit(code: unknown, signal: unknown): ProcessExit {
  return {
    code: typeof code === 'number' ? code : null,
    signal: typeof signal === 'string' ? signal : null,
  };
}

function stringifyChunk(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  return String(chunk);
}
