// The execution context contract: the desktop host and @gugu/session-core/deps/runtime share this one.
import type { ExecResult } from './types';
export type { ExecResult } from './types';

/**
 * Options for a single exec call on an IExecutionContext.
 * Named distinctly from BoundExec's ExecOptions to avoid collisions.
 */
export type ExecContextOptions = {
  timeout?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  /**
   * 隔离、非交互地跑一次:自己的进程组(abort 能收掉整棵树),**stdin 关闭**。
   * 后者是承重的(#6183):一个在 `--version` 上弹交互提示(登录、更新确认)或读 stdin 的程序,
   * stdin 开着就会永远等下去;关掉它,提示读到 EOF 直接退出。本机 = `stdio[0]:'ignore'`(Windows 同),
   * SSH = 关掉通道的 stdin。
   */
  processGroup?: boolean;
  /**
   * 这一次调用要用的**完整**环境。给了就照单全用,❌ 不与上下文自己那份合并 ——
   * 调用方给的是宿主算好的一整份(见 `composeAgentSpawnEnv`),半合并出来的是第三种环境。
   *
   * 为什么需要它(#5702):依赖体检对每个 agent 跑一次 `<bin> --version`,从前用的是通用外部
   * 工具环境 —— 于是「面板上显示的版本 / 装没装」是在一个和真正跑会话时**不同**的环境里量出来的。
   * 用户在 Agents 设置里填的环境变量恰恰能左右这份二进制跑不跑得起来。
   */
  env?: Record<string, string>;
};

/**
 * An execution context represents a host + optional working directory where
 * commands run. Implementations abstract the transport (local spawn vs SSH exec)
 * so consumers have no knowledge of whether they are running locally or remotely.
 */
export interface IExecutionContext {
  /** The working directory all commands run in. Undefined/empty = no cwd constraint. */
  readonly root?: string;

  /**
   * True only for LocalExecutionContext. Used by GitService to decide
   * whether to use CatFileBatch (local spawn) or git-show fallback (SSH).
   */
  readonly supportsLocalSpawn: boolean;

  /** Run a command and buffer all output. Rejects on non-zero exit code. */
  exec(
    command: string,
    args?: string[],
    opts?: ExecContextOptions
  ): Promise<ExecResult>;

  /**
   * Refresh any cached shell environment for this context. Installers often
   * write shell startup files or install into paths that become visible only
   * after recapturing the user's shell environment.
   */
  refreshShellEnv?(): Promise<void>;

  /**
   * Run a command and stream stdout chunks to `onChunk`.
   * Return false from `onChunk` to abort the process early (resolves normally).
   * Passing `signal` rejects with an AbortError when the signal fires.
   */
  execStreaming(
    command: string,
    args: string[],
    onChunk: (chunk: string) => boolean,
    opts?: { signal?: AbortSignal }
  ): Promise<void>;

  /**
   * Abort all in-flight exec/execStreaming calls and release resources.
   * Idempotent — safe to call multiple times.
   */
  dispose(): void;
}

/** An execution context whose cached shell environment can be refreshed on demand. */
export interface IShellRefreshableExecutionContext extends IExecutionContext {
  refreshShellEnv(): Promise<void>;
}
