import type { ChildProcess, ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
// 相对 `.ts` 路径同下:这份源码会被 node 直接跑。
import { execFile, spawn } from '../../../core/src/local/childProcess.ts';
import path from 'node:path';
import type { Readable } from 'node:stream';
// `.ts` 全路径:codex ACP 桥(runtime/codex-app-server-acp.mjs)在单测里由 node 直接跑这份源码。
import { planDirectSpawn } from './windows-launcher.ts';

/**
 * 一个被拥有的子进程:spawn 时拿到它,停的时候停的是它**整棵树**。平台差异只在这里。
 *
 * - POSIX:`detached: true` 让子进程自成一组,信号发给 `-pid`(整组);组已不在就退回只发给它本身。
 *   不 detached 的子进程与宿主同组,只能发给它本身。
 * - Windows:`detached` 一律不传给 spawn。那里它不是进程组,而是 `DETACHED_PROCESS`:子进程没有控制台,
 *   CREATE_NO_WINDOW 被系统忽略 ⇒ 它再起的每个控制台孙进程(git、reg、where…)各弹一个新黑框;包了
 *   cmd.exe / powershell.exe 时连输出都接不到管道上(2026-09-16 win-dev 实测 `codex.cmd --version`:
 *   detached:true 时 exit 0、stdout 空)。不 detached ⇒ 子进程拿到一个隐藏的控制台,孙进程继承它。
 *   没有进程组,`child.kill()` 只结束 `child.pid` 这一个进程。停止 = 在**活根**上异步
 *   `taskkill /T /F`,它沿父子链走完整棵树。根已退出时不再按它的 pid 发任何东西(pid 可能已被复用)。
 *   taskkill 一律异步起:同步 spawn 会挂住调用它的线程,而调用方包括 Electron 主进程的退出停机。
 *
 * 命令先经 `planDirectSpawn`:单可执行文件的 npm `.cmd` 壳直接换成那个 exe,换不出来的才包 cmd.exe ——
 * 包了壳时根是 cmd.exe,它要等自己的孩子退出才退出,所以「根活着」覆盖了真程序活着的全部时间。
 */
export interface OwnedChild<C extends ChildProcess = ChildProcess> {
  readonly child: C;
  /** 同步触发整树停止。Windows 上 taskkill 在根仍存活时失败,交给 `onError`。 */
  kill(signal?: NodeJS.Signals): void;
  /**
   * 停整树并等到它停下:POSIX 先 SIGTERM,`graceMs` 内没停就 SIGKILL;Windows 活根上 taskkill /T /F,
   * 再等根退出。到期没停下、或 taskkill 在根仍存活时失败 ⇒ reject。同一个 handle 只停一次。
   */
  stop(options?: { graceMs?: number; killMs?: number }): Promise<void>;
}

export type OwnedChildOptions = SpawnOptions & {
  /**
   * 这个子进程的错误出口:它的 'error' 事件(spawn 失败、Node 杀不动它)和 `kill()` 停不下来的树。
   * spawn 当场挂上 —— 没有监听者的 'error' 会被 Node 抛成未捕获异常,带走整个宿主。
   */
  onError: (error: Error) => void;
  platform?: NodeJS.Platform;
};

const POLL_MS = 50;

export function spawnOwnedChild(
  command: string,
  args: readonly string[],
  options: OwnedChildOptions & { stdio?: 'pipe' }
): OwnedChild<ChildProcessWithoutNullStreams>;
export function spawnOwnedChild(
  command: string,
  args: readonly string[],
  options: OwnedChildOptions & { stdio: ['ignore' | 'pipe', 'pipe', 'pipe'] }
): OwnedChild<ChildProcess & { stdout: Readable; stderr: Readable }>;
export function spawnOwnedChild(command: string, args: readonly string[], options: OwnedChildOptions): OwnedChild;
export function spawnOwnedChild(
  command: string,
  args: readonly string[],
  { onError, platform = process.platform, ...spawnOptions }: OwnedChildOptions
): OwnedChild {
  const launch = planDirectSpawn(command, args, { env: spawnOptions.env, platform });
  const windows = platform === 'win32';
  const group = !windows && spawnOptions.detached === true;
  const child = spawn(launch.command, launch.args, { ...spawnOptions, ...launch.spawnOverrides, detached: group });
  child.on('error', onError);
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  const hasExited = (): boolean => child.exitCode != null || child.signalCode != null;
  /** 根已退出,且(成组时)组里也没人了 —— 此后这个 pid / pgid 可能被复用,不再对它发任何信号。 */
  const isSettled = (): boolean => hasExited() && !(group && processAlive(-child.pid!));

  const signal = (sig: NodeJS.Signals): void => {
    if (child.pid === undefined || isSettled()) return;
    if (group) {
      try {
        process.kill(-child.pid, sig);
        return;
      } catch {
        // 组已经没了(或只剩组长):退回只发给它本身。
      }
    }
    child.kill(sig);
  };

  /** 一个 handle 只起一次 taskkill:`kill()` 与随后的 `stop()` 等的是同一次。 */
  let treeKill: Promise<void> | undefined;
  const killTree = (): Promise<void> => {
    const pid = child.pid;
    if (pid === undefined || hasExited()) return Promise.resolve();
    treeKill ??= taskkillTree(pid).catch((error: unknown) => {
      if (!hasExited() && processAlive(pid)) throw error;
    });
    return treeKill;
  };

  const settled = async (ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (!isSettled()) {
      if (Date.now() >= deadline) return false;
      // 根的 exit 是事件;根退了之后组里剩下的成员只能轮询。
      await (hasExited() ? sleep(POLL_MS) : Promise.race([exited, sleep(POLL_MS)]));
    }
    return true;
  };

  let stopping: Promise<void> | undefined;
  const stop = async ({ graceMs = 2_000, killMs = 2_000 } = {}): Promise<void> => {
    if (child.pid === undefined) return;
    if (windows) {
      await killTree();
      if (!(await settled(graceMs + killMs))) {
        throw new Error(`process tree ${child.pid} still running ${graceMs + killMs}ms after taskkill`);
      }
      return;
    }
    signal('SIGTERM');
    if (await settled(graceMs)) return;
    signal('SIGKILL');
    if (await settled(killMs)) return;
    throw new Error(`${group ? 'process group' : 'process'} ${child.pid} still running after SIGTERM and SIGKILL`);
  };

  return {
    child,
    kill(sig = 'SIGTERM') {
      if (!windows) {
        signal(sig);
        return;
      }
      killTree().catch((error: unknown) => onError(error as Error));
    },
    stop(stopOptions) {
      stopping ??= stop(stopOptions);
      return stopping;
    },
  };
}

function taskkillTree(pid: number): Promise<void> {
  // 按系统目录取绝对路径:PATH 上同名的别的东西不该被当成 taskkill。
  const taskkill = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  return new Promise((resolve, reject) => {
    execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { timeout: 5_000 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`taskkill /T /F ${pid} failed: ${error.message} ${String(stderr).trim()}`));
      else resolve();
    });
  });
}

/** 信号 0 只问存在与否(负 pid = 整组);EPERM = 存在但不归我们发信号。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
