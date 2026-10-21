import type { IExecutionContext } from '../../exec/execution-context';
import type { Platform } from '../capability';
import { toPlatform } from './install-options';
import type { DependencyStatus, ProbeResult } from './types';

/**
 * 版本号长什么样。判「它报出版本了吗」和抽取版本号用的是同一把尺。
 *
 * ⚠️ 每一段都必须以数字收尾。原来写的是 `[\d.]*`,它会把**句末的那个点**一起吃进来 ——
 * GitHub Copilot 的 `--version` 打印 `1.0.87.`,面板于是写着「已安装 v1.0.87.」。
 * 2026-09-22 真机撞到。`.test` 那一路不受影响:带句点的版本串照样含有一个合法版本子串。
 */
export const VERSION_RE = /(\d+\.\d+(?:\.\d+)*)/;

/**
 * 一次探测该读成什么状态。
 *
 * **这是唯一一份口径。** 曾经有两份:`resolveProbeStatus` 里一份、`descriptor-from-provider`
 * 里给每个 agent 兜底的 `agentResolveStatus` 里一份 —— 后者第一句就是「解析出路径就算可用」,
 * 而它才是 agent 实际走的那条。只改前一份的结果是:单测全绿、真机纹丝不动。#4271
 * ⇒ 那条可覆盖的口径(descriptor 上的 `resolveStatus` 与插件侧的 behavior 钩子)已整条删掉,
 *   全仓只剩这一个函数,❌ 别再开第二个入口。
 *
 * 判据:
 * - 文件在 ≠ 它能跑。升级 Node 之后 npm 的 shim 指着不存在的运行时、二进制架构不对、依赖库
 *   缺失、切安装渠道切到一半 —— 都是文件好端端在盘上、一跑就挂。
 * - 留了余地:非零退出**但仍然报出了版本号**的照旧算可用,有些 CLI 的 `--version` 本来就以
 *   非零退出。只有「跑挂了而且没报出版本」才判 error。
 */
export function defaultProbeStatus(result: ProbeResult): DependencyStatus {
  const ranAndFailed = result.exitCode !== null && result.exitCode !== 0 && !result.timedOut;
  const reportedAVersion = VERSION_RE.test((result.stdout || result.stderr).split('\n')[0] ?? '');
  if (result.path !== null) return ranAndFailed && !reportedAVersion ? 'error' : 'available';
  if (result.timedOut && result.stdout) return 'available';
  if (result.exitCode !== null && (result.stdout || result.stderr)) return 'available';
  return result.exitCode === null ? 'missing' : 'error';
}

const WHICH_TIMEOUT_MS = 5_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const REALPATH_TIMEOUT_MS = 5_000;

function targetPlatform(platform?: Platform): Platform {
  return platform ?? toPlatform(process.platform);
}

function outputLines(stdout: string): string[] {
  return stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * `where` may emit npm's extensionless POSIX shim before its Windows launcher.
 * Keep entries in PATH/PATHEXT order while dropping npm's extensionless POSIX
 * shim. Windows launchers such as cmd/ps1 remain available to platform-aware
 * callers.
 */
function windowsCommandPaths(stdout: string): string[] {
  return outputLines(stdout).filter((path) => /(?:^|[\\/])[^\\/]+\.[^\\/]+$/.test(path));
}

/**
 * `where` only takes a file name pattern, or `dir:pattern` to look in one directory. Handed a path
 * (`where C:\node\claude.cmd`) it exits 2 with `ERROR: Invalid pattern is specified in
 * "path:pattern"`, so every absolute path — a pinned copy, a saved path, a cached probe result —
 * read as "not found" on Windows. Split a path into the `dir:pattern` form `where` does accept.
 *
 * Split by hand rather than with `node:path`: this module also ships in the renderer bundle.
 */
function windowsWhereArgument(command: string): string {
  const separator = Math.max(command.lastIndexOf('\\'), command.lastIndexOf('/'));
  if (separator < 0) return command;
  const head = command.slice(0, separator);
  // A file at a drive or filesystem root keeps its separator: `C:\:claude.exe`, not `C::claude.exe`.
  const directory = head === '' || /^[A-Za-z]:$/.test(head) ? command.slice(0, separator + 1) : head;
  return `${directory}:${command.slice(separator + 1)}`;
}

/**
 * Resolves all usable absolute paths for a command binary. Uses `where` on
 * Windows (filtering non-Windows shims) and `which -a` on
 * macOS/Linux. Returns an empty array when the command is not found.
 *
 * The first entry is the PATH winner (same result as resolveCommandPath).
 */
export async function resolveAllCommandPaths(
  command: string,
  ctx: IExecutionContext,
  platform?: Platform
): Promise<string[]> {
  const plat = targetPlatform(platform);
  try {
    if (plat === 'windows') {
      const { stdout } = await ctx.exec('where', [windowsWhereArgument(command)], {
        timeout: WHICH_TIMEOUT_MS,
      });
      return windowsCommandPaths(stdout);
    }
    const { stdout } = await ctx.exec('which', ['-a', command], { timeout: WHICH_TIMEOUT_MS });
    return outputLines(stdout);
  } catch {
    return [];
  }
}

/**
 * 厂商把 CLI 放在**固定安装位置**、却不放上 PATH 时(例:ZCode 的 CLI 是桌面 app 包里的
 * `resources/glm/zcode.cjs`),按声明的位置找它。只认两种展开,都在**目标机器上**做(本机与
 * SSH 远端同一条路):POSIX 开头的 `~/`(目标机的 `$HOME`)、Windows 的 `%VAR%`(目标机的 `cmd`)。
 * 展开不出来的那一条直接跳过 —— 没装就是没装,❌ 拿字面量去碰运气。返回存在的那几条,按声明顺序。
 */
export async function resolveKnownPaths(
  paths: readonly string[],
  ctx: IExecutionContext,
  platform?: Platform
): Promise<string[]> {
  const plat = targetPlatform(platform);
  const found: string[] = [];
  for (const declared of paths) {
    const expanded = await expandKnownPath(declared, ctx, plat);
    if (!expanded) continue;
    const resolved = await resolveCommandPath(expanded, ctx, plat);
    if (resolved) found.push(resolved);
  }
  return found;
}

async function expandKnownPath(path: string, ctx: IExecutionContext, plat: Platform): Promise<string | null> {
  try {
    if (plat === 'windows') {
      if (!/%[A-Za-z_][A-Za-z0-9_]*%/.test(path)) return path;
      const { stdout } = await ctx.exec('cmd', ['/d', '/c', 'echo', path], { timeout: WHICH_TIMEOUT_MS });
      const expanded = stdout.trim();
      // 未定义的变量 `cmd` 会原样回显 ⇒ 仍带 %…% 就是展开失败。
      return expanded && !/%[A-Za-z_][A-Za-z0-9_]*%/.test(expanded) ? expanded : null;
    }
    if (!path.startsWith('~/')) return path;
    const { stdout } = await ctx.exec('sh', ['-c', 'printf %s "$HOME"'], { timeout: WHICH_TIMEOUT_MS });
    const home = stdout.trim();
    return home ? `${home}${path.slice(1)}` : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the absolute path of a command binary.
 * Uses `where` on Windows and `which` on macOS/Linux.
 * Returns `null` if the command is not found or the resolution fails.
 */
export async function resolveCommandPath(
  command: string,
  ctx: IExecutionContext,
  platform?: Platform
): Promise<string | null> {
  const plat = targetPlatform(platform);
  const resolveCmd = plat === 'windows' ? 'where' : 'which';
  const resolveArg = plat === 'windows' ? windowsWhereArgument(command) : command;
  try {
    const { stdout } = await ctx.exec(resolveCmd, [resolveArg], { timeout: WHICH_TIMEOUT_MS });
    const paths = plat === 'windows' ? windowsCommandPaths(stdout) : outputLines(stdout);
    return paths[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves the canonical realpath of a binary by following symlinks.
 * Runs `realpath` on Unix or falls back to the given path on failure/Windows.
 * Used to determine the true install location for method inference.
 */
export async function resolveRealpath(
  resolvedPath: string,
  ctx: IExecutionContext,
  platform?: Platform
): Promise<string> {
  if (targetPlatform(platform) === 'windows') return resolvedPath;
  try {
    const { stdout } = await ctx.exec('realpath', [resolvedPath], {
      timeout: REALPATH_TIMEOUT_MS,
    });
    const real = stdout.trim();
    return real || resolvedPath;
  } catch {
    return resolvedPath;
  }
}

/**
 * 版本探测也是一次「跑它」:把 harness 声明的会话级开关(#6186 关自更新,`selfUpdate` 的 env)叠在探测环境上。
 * copilot 实测 `--version` 就会把新版下载进 `~/Library/Caches/copilot/pkg`。
 *
 * - 调用方给了完整环境 ⇒ 叠在它上面;
 * - 没给 ⇒ 子进程本来就继承本进程的环境,从同一份出发再叠;
 * - 执行上下文带不了单次 env(SSH 会响亮抛错)⇒ 原样返回,远端探测的开关是已知缺口。
 */
export function withProbeSwitches(
  ctx: Pick<IExecutionContext, 'supportsLocalSpawn'>,
  base: Record<string, string> | undefined,
  switches: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (!switches || Object.keys(switches).length === 0 || !ctx.supportsLocalSpawn) return base;
  const from = base ?? Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  return { ...from, ...switches };
}

/**
 * Runs `command args` and collects stdout/stderr up to a timeout.
 * Never throws — all failures are captured in the returned `ProbeResult`.
 *
 * `env` 是这一份二进制**真正跑起来时**的那份环境(#5702)。不给它,量到的「装没装、什么版本」
 * 就是在另一个环境里量出来的 —— 而用户在 Agents 设置里填的环境变量恰恰能左右它跑不跑得起来。
 */
export async function runVersionProbe(
  command: string,
  resolvedPath: string | null,
  args: string[],
  ctx: IExecutionContext,
  opts: { timeoutMs?: number; env?: Record<string, string> } = {}
): Promise<ProbeResult> {
  const bin = resolvedPath ?? command;
  try {
    const { stdout, stderr, processGroupResidualCount } = await ctx.exec(bin, args, {
      timeout: opts.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS,
      processGroup: true,
      env: opts.env,
    });
    return {
      command,
      path: resolvedPath,
      stdout,
      stderr,
      exitCode: 0,
      timedOut: false,
      processGroupResidualCount,
    };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
      timedOut?: boolean;
      processGroupResidualCount?: number;
    };
    return {
      command,
      path: resolvedPath,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.code ?? null,
      timedOut: !!(e.timedOut ?? e.killed),
      processGroupResidualCount: e.processGroupResidualCount,
    };
  }
}
