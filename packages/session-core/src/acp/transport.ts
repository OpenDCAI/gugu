import { dirname } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { TerminalExit } from './models/terminals';

/** Exit status of a terminal command — mirrors the ACP WaitForTerminalExitResponse shape. */
export type AcpTerminalExit = TerminalExit;

/**
 * A running command spawned by the client on behalf of an ACP agent.
 * The runtime buffers its combined stdout+stderr output; the host only
 * provides the raw streams, exit callback, and kill primitive.
 */
export interface AcpTerminalProcess {
  /** Combined output stream (stdout; stderr is merged in at the host level if available). */
  readonly stdout: Readable;
  /** Separate stderr stream when the host can provide it separately. */
  readonly stderr?: Readable;
  /** Exit code if the process has already exited, null otherwise. */
  readonly exitCode: number | null;
  /** Register a callback to be called when the process exits. */
  onExit(cb: (status: AcpTerminalExit) => void): void;
  /** Register a callback to be called if the process emits an error. */
  onError(cb: (err: Error) => void): void;
  /** Send a termination signal to the process. */
  kill(signal?: NodeJS.Signals): void;
}

/**
 * 适配器进程是怎么结束的。**两个字段都必答**:`code` 为 null 且 `signal` 有值 = 被信号杀掉,
 * 两者都为 null = 传输层根本没有本地进程。少了 signal 这一维,`SIGTERM` 与「正常退出但没给码」
 * 在日志里长得一模一样,而这正是 #5379 里「适配器为什么退」查不出来的一半原因。
 */
export type AcpProcessExit = {
  readonly code: number | null;
  readonly signal: string | null;
};

export {
  defaultEngineTreeOps,
  reapEngineTree,
  signalEngineTree,
  type EngineTreeOps,
  type EngineTreeReap,
} from './engine-tree';

/**
 * Uniform view of a running agent process, regardless of whether it is a local
 * child process or a remote SSH exec channel.
 */
export interface AcpProcessHandle {
  /** JSON-RPC framing input (writable end of the stdio pipe). */
  readonly stdin: Writable;
  /** JSON-RPC framing output (readable end of the stdio pipe). */
  readonly stdout: Readable;
  /** Optional separate stderr stream (not available on PTY channels). */
  readonly stderr?: Readable;
  /** Exit code if the process has already exited, null otherwise. */
  readonly exitCode: number | null;
  /**
   * OS pid of the process this handle reads replies from, or `null` when the transport has no
   * local process (an SSH channel, a fake, a recording).
   *
   * ⚠️ 必答而非可选:一个回合里可以同时存在多个 provider 进程(实测一轮 3 个、env 各不相同),
   * 而「这一回合到底哪个进程在回答」此前**产品自己也答不出**。该绑定由 spawn 当场构造,
   * ❌ 不是事后按存活或时序反推。
   */
  readonly pid: number | null;
  /** Register a callback to be called when the process exits. */
  onExit(cb: (exit: AcpProcessExit) => void): void;
  /** Register a callback to be called if the process emits an error. */
  onError(cb: (err: Error) => void): void;
  /** Send a termination signal to the process. */
  kill(signal?: NodeJS.Signals): void;
  /**
   * @@@5405 结束这个 handle 拥有的**整棵**进程树里还活着的东西,并报告收掉了几个。
   *
   * 为什么 `kill()` 不够:`kill()` 是「请你走」,而这一条是「你已经走了,把你带不走的收干净」。
   * 投递进程被 SIGKILL 时它没有机会收自己拉起的引擎,引擎当场 reparent 到 PID1 继续跑 ——
   * 这个 handle 从一开始拥有的就不是一个进程,而是一棵树,这个动词只是把那件事说出来。
   *
   * 由连接层在**退出边**调用一次,并且必须在把「进程没了」报给宿主**之前**:宿主收到那条通知
   * 就会结算这一代平台额度,而一个还活着的引擎握着刚被结算掉的令牌,下一次调用就是 401。
   * 没有本机进程树的传输(SSH 通道、录制、假件)如实报 0。
   */
  reap(): Promise<{ reaped: number; pids: number[] }>;
}

export interface AcpFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, content: string, encoding: 'utf8'): Promise<void>;
  mkdir(path: string, opts: { recursive: boolean }): Promise<unknown>;
}

/** Read a UTF-8 file via an AcpFs adapter, wrapping errors with the file path. */
export async function readTextFile(fs: AcpFs, path: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (err) {
    throw new Error(
      `readTextFile failed for ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Create parent directories and write a UTF-8 file via an AcpFs adapter. */
export async function writeTextFile(fs: AcpFs, path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content, 'utf8');
}

/**
 * Represents a specific machine's ACP process host: can resolve the agent
 * executable + env for a given provider, spawn an agent process, and provide a
 * file-system adapter for the ACP client file handlers.
 */
export interface AcpProcessHost {
  /**
   * Resolve the agent CLI path and environment variables for the given provider.
   * The host impl looks up binary names and cached paths internally.
   */
  resolveSpawnContext(
    providerId: string
  ): Promise<{ cli: string; agentEnv: Record<string, string> }>;

  /**
   * Spawn the agent process and return a handle to its stdio streams.
   */
  spawn(spec: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }): Promise<AcpProcessHandle>;

  /**
   * Spawn a terminal command on behalf of an ACP agent.
   * Optional — omit on hosts that cannot host agent terminals.
   * When present the runtime will advertise `terminal: true` in `clientCapabilities`.
   */
  spawnTerminal?(spec: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }): Promise<AcpTerminalProcess>;

  /** File system adapter scoped to the remote or local machine. */
  readonly fs: AcpFs;
}
