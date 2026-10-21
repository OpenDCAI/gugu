import type { Unsubscribe } from '@gugu/session-shared';
import type { Scope } from '../util';

export type ProcessSupervision =
  | {
      restart: 'never';
    }
  | {
      restart: 'on-failure';
      backoffMs?: number[];
      maxRestarts?: number;
    };

export type ProcessSpec = {
  entry: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  supervision?: ProcessSupervision;
  gracefulShutdown?: {
    message?: unknown;
    graceMs: number;
  };
};

export type ProcessExit = {
  code: number | null;
  signal?: string | null;
};

export type ManagedProcessExit = ProcessExit & {
  willRestart: boolean;
};

export type StdioStream = 'stdout' | 'stderr';

export interface ManagedProcess {
  readonly pid: number | undefined;
  send(message: unknown): void;
  onMessage(cb: (message: unknown) => void): Unsubscribe;
  onExit(cb: (exit: ManagedProcessExit) => void): Unsubscribe;
  onStdio(cb: (stream: StdioStream, chunk: string) => void): Unsubscribe;
  /**
   * @@@unhandled-error-event (#4942) — 子进程及其管道的错误出口。**契约的一部分,不是可选装饰**:
   * 没有它时这些错误走 Node 的「无监听者 'error' ⇒ 未捕获异常」路径,把整个宿主带走。
   */
  onError(cb: (error: Error) => void): Unsubscribe;
  dispose(): Promise<void>;
}

export interface ProcessHost {
  spawn(spec: ProcessSpec, scope?: Scope): Promise<ManagedProcess>;
}

export interface ChildHandle {
  readonly pid?: number;
  send(message: unknown): void;
  onMessage(cb: (message: unknown) => void): Unsubscribe;
  onExit(cb: (exit: ProcessExit) => void): Unsubscribe;
  onStdio(cb: (stream: StdioStream, chunk: string) => void): Unsubscribe;
  /** 见 ManagedProcess.onError。实现方**必须**在创建那一刻就把监听挂上,不能等订阅者出现。 */
  onError(cb: (error: Error) => void): Unsubscribe;
  kill(): void | Promise<void>;
}

export type SpawnChild = (spec: ProcessSpec, scope: Scope) => ChildHandle | Promise<ChildHandle>;
