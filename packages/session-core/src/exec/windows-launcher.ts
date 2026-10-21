import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { WindowsShimReader } from './windows-node-entry';

/**
 * Windows 上「已经解析出一个程序路径，现在要直接把它 spawn 起来」这件事的**唯一一份**做法。
 *
 * 为什么需要它：npm 在 Windows 上给全局包留下的入口不是可执行文件，而是一个 `.cmd` 批处理壳
 * （`<prefix>\codex.cmd`，真正的程序在旁边的 node_modules 里）。而 Node 自 18.20.2 / 20.12.2 起
 * （修 CVE-2024-27980）**禁止**不经 shell 直接执行 `.cmd` / `.bat` —— `spawn` 当场抛 `EINVAL`，
 * 而且是同步抛，连 `error` 事件都不给。
 *
 * 症状因此长得完全不像真因：文件明明躺在盘上，`<bin> --version` 却"跑失败了"，于是
 * 依赖探测判成 error、安装流程判成「安装后未检测到」—— 用户看到的是「命令跑完了，但还是找不到它」，
 * 然后去换镜像源、开关梯子、重启应用，一样都没用（#5719）。
 *
 * ❌ 不用 `shell: true` 代替：Node 在 Windows 上会把 file 与 args **不加引号**直接拼成命令行，
 * 路径里一个空格就散架（`C:\Program Files\...`）。这里自己拼、自己转义。
 *
 * 单可执行文件的 npm 壳（`"%dp0%\…\opencode.exe" %*`）不包 cmd.exe，直接起那个 exe：壳换不出来的才包。
 * 包了一层 cmd.exe 之后，`child.kill()` 只杀壳 ⇒ 要停它的拥有者用 `spawnOwnedChild`（owned-child.ts）。
 */

/** spawn / execFile 的 options 里需要一并带上的东西；不包壳时是空对象。 */
export type WindowsLauncherOverrides = {
  /** 命令行由我们自己拼好并转义完毕，Node 不要再插手。 */
  windowsVerbatimArguments?: true;
  /** 别让包进来的 cmd.exe / powershell.exe 在 GUI 应用底下闪一个黑窗。 */
  windowsHide?: true;
  /**
   * 包了壳就**必须**关掉 `detached`——否则输出全丢。
   *
   * Windows 上 `detached: true` = `DETACHED_PROCESS`，子进程不继承控制台；`cmd.exe` /
   * `powershell.exe` 在这种情况下不会把它自己那个子进程的 stdout 接到我们给的管道上，
   * 于是**退出码是 0、stdout 却是空的**——探测因此判成「装上了，但版本读不出来」，
   * 面板显示一个没有版本号的条目（真机实测，见下）。
   *
   * 2026-09-16 在 win-dev（Windows Server 2025，Node 24.14）上的对照：
   * | 被跑的东西 | detached:true | detached:false |
   * |---|---|---|
   * | `codex.cmd --version`（经 cmd.exe） | exit 0，stdout **空** | exit 0，`codex-cli 0.154.0` |
   * | `codex.ps1 --version`（经 powershell.exe） | exit 0，stdout **空** | exit 0，`codex-cli 0.154.0` |
   * | `node.exe --version`（不包壳） | 正常 | 正常 |
   *
   * ⇒ 只在**包了壳**时关掉它；不包壳的那条路照旧（POSIX 上那边还靠它组建进程组）。
   */
  detached?: false;
};

export type DirectSpawnPlan = {
  command: string;
  args: string[];
  spawnOverrides: WindowsLauncherOverrides;
  /** 包了 cmd.exe / powershell.exe：`child.pid` 是壳，真程序是它的孩子。 */
  wrapsShell: boolean;
};

/** Windows 的环境变量名不分大小写，`ComSpec` / `COMSPEC` / `comspec` 都得认。 */
function windowsEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted && value) return value;
  }
  return undefined;
}

/**
 * cmd.exe 会先解析一次命令行，npm 风格的 `.cmd` 壳里那句 `%*` 再转发一次 —— 所以参数要按
 * **两层**转义，否则带空格或引号的参数在壳里就散了。这份算法沿用 cross-spawn，与
 * `codex-app-server-transport.ts` 共用同一份（那条路先踩出来的，#2808）。
 */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** 程序路径这一层：只过一次 cmd.exe 的解析。 */
export function escapeCmdCommand(input: string): string {
  return input.replace(CMD_META_CHARS, '^$1');
}

/** 参数这一层：先按 Windows argv 规矩引住，再过两遍 cmd.exe 的转义（壳里的 `%*` 是第二遍）。 */
export function escapeCmdShimArgument(input: string): string {
  let escaped = input.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, '$1$1');
  escaped = `"${escaped}"`.replace(CMD_META_CHARS, '^$1');
  return escaped.replace(CMD_META_CHARS, '^$1');
}

const PASSTHROUGH: WindowsLauncherOverrides = {};

/**
 * 把「跑这个程序」翻译成这台机器上真跑得起来的 argv。
 *
 * 非 Windows、以及 Windows 上的真可执行文件（`.exe` / 无扩展名）原样透传 —— 这条函数只在
 * 壳脚本上改变行为，别的什么都不动。
 */
export function planDirectSpawn(
  command: string,
  args: readonly string[] = [],
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } & Omit<WindowsHandoffOptions, 'platform'> = {}
): DirectSpawnPlan {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return { command, args: [...args], spawnOverrides: PASSTHROUGH, wrapsShell: false };
  }

  const env = options.env ?? process.env;
  const extension = path.win32.extname(command).toLowerCase();
  const program = extension === '.cmd' || extension === '.ps1'
    ? resolveWindowsHandoffExecutable(command, { ...options, platform })
    : null;
  if (program) return { command: program, args: [...args], spawnOverrides: PASSTHROUGH, wrapsShell: false };

  if (extension === '.cmd' || extension === '.bat') {
    const commandLine = [escapeCmdCommand(command), ...args.map(escapeCmdShimArgument)].join(' ');
    return {
      command: windowsEnvValue(env, 'ComSpec') ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${commandLine}"`],
      spawnOverrides: { windowsVerbatimArguments: true, windowsHide: true, detached: false },
      wrapsShell: true,
    };
  }

  if (extension === '.ps1') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...args],
      spawnOverrides: { windowsHide: true, detached: false },
      wrapsShell: true,
    };
  }

  return { command, args: [...args], spawnOverrides: PASSTHROUGH, wrapsShell: false };
}

// ── 交给别人的进程去 spawn 的那条路径 ──────────────────────────────────────────

/**
 * 上面 `planDirectSpawn` 解决的是「**我们自己**怎么把这个壳跑起来」。
 * 这一节解决的是另一半:**路径要交给别人的进程去 spawn**,而那边不会替我们包壳。
 *
 * 现场(2026-09-18 Windows 真机):咕咕把 `ctx.cli` 放进 `CLAUDE_CODE_EXECUTABLE`,交给
 * 厂商的 ACP 适配器(`@agentclientprotocol/claude-agent-acp`)+ Claude Agent SDK。
 * npm 在 Windows 上留下的入口是 `claude.cmd`,SDK 直接 `spawn` 它 —— Node 自
 * 18.20.2 / 20.12.2 起(修 CVE-2024-27980)禁止不经 shell 执行 `.cmd`,于是
 * `session/new` 回的是 `{"code":-32603,"message":"Internal error","data":{"details":"spawn EINVAL"}}`。
 *
 * ⇒ 用户看到的不是「起不来」,而是**整档模型消失**:模型目录靠这条 `session/new` 探,
 *    探失败 ⇒ 「你的 Claude Code 模型」那一组连同它下面的登录入口一起不渲染,
 *    下拉里只剩咕咕代付的那一档。真因与症状之间隔着三层。
 *
 * ❌ 不能用 `shell: true` 或包一层 `cmd.exe` 补救:那两样都得由**真正 spawn 的那一方**做,
 *    而那一方是别人的代码。我们能给的只有一条路径 ⇒ 那条路径必须自己就能被 spawn。
 *
 * 好在 npm 的 `.cmd` 壳里写着它到底要跑什么。`@anthropic-ai/claude-code` 这类**原生**包的壳
 * 就是一行 `"%dp0%\node_modules\…\claude.exe"   %*` —— 把它读出来即可。
 * 壳里要跑的不是单个可执行文件(例如 `node "%dp0%\…\cli.js" %*`)时返回 null:
 * 那种情况没有「一条能交出去的路径」,**由调用方响亮失败**,❌ 不猜一个。
 */

/** Windows 上 Node 能直接 spawn 的东西:真可执行文件(或无扩展名的那种)。 */
function isDirectlySpawnableOnWindows(command: string): boolean {
  const extension = path.win32.extname(command).toLowerCase();
  return extension === '' || extension === '.exe' || extension === '.com';
}

/**
 * npm cmd-shim 里那一行「跑这一个程序,把参数原样转发」。
 * 必须是**整行只有这一个程序 + `%*`**:`node "…\cli.js" %*` 那种多一个参数的不匹配 ——
 * 匹配上就会把 `node.exe` 当成目标,丢掉真正要跑的那个脚本。
 */
const CMD_SHIM_SINGLE_PROGRAM = /^\s*"([^"\r\n]+\.(?:exe|com))"\s+%\*\s*$/im;

/** 壳里的 `%dp0%` / `%~dp0` = 壳自己所在目录(带尾分隔符)。 */
function expandShimDirectory(template: string, shimPath: string): string {
  const directory = path.win32.dirname(shimPath);
  const expanded = template.replace(/%~?dp0%?/gi, `${directory}\\`);
  // `"%dp0%\node_modules\…"` 展开后会多出一个分隔符;Windows 认,但路径比对不认。
  return expanded.replace(/(?<!^)\\{2,}/g, '\\');
}

export type WindowsHandoffOptions = {
  platform?: NodeJS.Platform;
  /** 读壳脚本;读不到返回 null。抽出来是为了让判据不依赖真实文件系统。 */
  readShim?: (shimPath: string) => string | null;
  /** 目标是否真的存在。 */
  exists?: (candidate: string) => boolean;
};

/**
 * 把一条**要交给别的进程去 spawn** 的路径,翻译成那边真 spawn 得起来的路径。
 * 翻译不出来时返回 null —— 调用方据此响亮失败,❌ 不静默回落。
 */
export function resolveWindowsHandoffExecutable(
  command: string,
  options: WindowsHandoffOptions = {}
): string | null {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return command;
  if (isDirectlySpawnableOnWindows(command)) return command;

  const extension = path.win32.extname(command).toLowerCase();
  if (extension !== '.cmd' && extension !== '.bat' && extension !== '.ps1') return null;

  // npm 三个壳(`name` / `name.cmd` / `name.ps1`)是一起写下的,`.cmd` 那份格式最稳,统一读它。
  const shimPath = extension === '.cmd'
    ? command
    : `${command.slice(0, command.length - extension.length)}.cmd`;

  const readShim = options.readShim ?? defaultReadShim;
  const text = readShim(shimPath);
  if (!text) return null;

  const match = CMD_SHIM_SINGLE_PROGRAM.exec(text);
  if (!match) return null;

  const target = expandShimDirectory(match[1]!, shimPath);
  const exists = options.exists ?? defaultExists;
  return exists(target) ? target : null;
}

// ── 交给 node 去跑的那条路径 ──────────────────────────────────────────────────

/**
 * 真读盘的壳读取器,交给 `resolveWindowsNodeScriptEntry`(`windows-node-entry.ts`)用(#6390)。
 * 那个解析函数住在不带 `node:` 导入的模块里 —— 它经 agents/plugins 的 barrel 进了 web 构建;
 * 读盘这一半只由 node 侧的宿主(Electron 主进程、worker 的 boot)注入。
 */
export const diskWindowsShimReader: WindowsShimReader = {
  readShim: (shimPath) => defaultReadShim(shimPath),
  exists: (candidate) => defaultExists(candidate),
};

/**
 * 一个可执行文件此刻的「身份」:这条路径此刻指着的真实文件(跟随符号链接)+ 那份文件的 mtime + size。
 * 就地升级路径不变而文件换了:原生安装器改软链接指向 ⇒ 真实文件变;npm / brew 原地覆盖 ⇒ mtime 变。
 * 并进键里的缓存因此换了那份文件就查不中 —— 版本探针(`resolveSessionRuntimeCompatible` 的 `fileStamp`)
 * 与模型目录的输入指纹(`resolveHarnessSpawnIdentity`,#7081)。只 stat,不起进程。读不到就是 null。
 */
export function diskFileStamp(file: string): string | null {
  try {
    const real = realpathSync(file);
    const stat = statSync(real);
    return `${real}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function defaultReadShim(shimPath: string): string | null {
  try {
    return readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
}

function defaultExists(candidate: string): boolean {
  try {
    return existsSync(candidate);
  } catch {
    return false;
  }
}
