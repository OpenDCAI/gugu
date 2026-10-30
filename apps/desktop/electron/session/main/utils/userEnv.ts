import fs from 'node:fs';
import path from 'node:path';
import {
  agentBinDirsInPriorityOrder,
  vendorInstallDirs,
} from '@main/core/dependencies/managed-agent-home';
import { log } from '@main/lib/logger';

/**
 * 解析 agent 时优先看这些目录。第一位是咕咕自己的安装目录 —— 它**不会**出现在用户登录
 * shell 的 PATH 里,所以必须由咕咕自己前置,否则「装进去了却找不到」。`~/.local/bin`
 * 留在后面:那是 codex 一类官方安装脚本的默认落点,用户机器上早就装好的副本仍要能被找到。
 *
 * 惰性求值:`GUGU_HOME` 是 main.ts 在启动早期才写进 env 的,模块求值期读会读到旧值。
 */
function userBinDirs(): string[] {
  return agentBinDirsInPriorityOrder();
}

function pathEntryExists(entry: string): boolean {
  try {
    return fs.statSync(entry).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 让 PATH 满足咕咕的解析优先级。
 *
 * `candidates[0]` 是**咕咕自己的**安装目录，它被**移到最前**——已经在 PATH 里也移动；
 * 目录还不存在也照样放（#935）：第一次发布启动器的那一刻才建出来，解析不能等到下一次
 * 有人再调这里（干净 profile 上本机助理装完探测不到、残留的启动器让每次重试都 EEXIST）。
 * 其余候选是用户自己的目录，只在缺失时补上、已存在则原地不动：它们之间的先后是用户的
 * 偏好，咕咕不去重排。
 *
 * `trailing` 是各家官方安装器的标准落点（见 `vendorInstallDirs`），**追加在最末尾**。
 * 它解决的是「用户先照官网装好了、咕咕却说你没装」：发现靠的是 PATH，而 PATH 是用户环境里
 * 最不稳的东西。放最后 = 只让它被看见，不改变谁先被找到。
 *
 * 为什么第一项必须是"移动"而不是"不在就补"：`rehydrateLoginShellPath()` 会把登录 shell 的
 * PATH 整体排到前面（安装脚本刚往 rc 里写过东西，必须重读）。咕咕的目录那时已经在 PATH 里，
 * 若只判"存在就跳过"，它会留在末尾，被 `~/.local/bin` 里的旧副本重新遮住——正是 #4271
 * 那一幕：更新成功、版本不变。
 */
export function ensureUserBinDirsInPath(
  candidates: string[] = userBinDirs(),
  trailing: string[] = vendorInstallDirs()
): string[] {
  const currentPath = process.env.PATH ?? '';
  const entries = currentPath.split(path.delimiter).filter(Boolean);

  const [managed, ...userOwned] = candidates;
  const rest = managed !== undefined ? entries.filter((entry) => entry !== managed) : entries;
  const existing = new Set(rest);
  const additions = userOwned.filter(
    (candidate) => pathEntryExists(candidate) && !existing.has(candidate)
  );

  // 厂商安装器的标准落点**追加在最后**:只为「让原本看不见的那一份被发现」,
  // ❌ 不参与「谁先被找到」的排序 —— 前置会把用户自己 PATH 里那一份顶掉。
  const seenAfterHead = new Set([...additions, ...rest]);
  const appended = trailing.filter((candidate) => {
    if (seenAfterHead.has(candidate) || !pathEntryExists(candidate)) return false;
    seenAfterHead.add(candidate);
    return true;
  });

  const nextPath = [...(managed !== undefined ? [managed] : []), ...additions, ...rest, ...appended].join(
    path.delimiter
  );
  if (nextPath === currentPath) {
    return [];
  }

  process.env.PATH = nextPath;
  const managedWasAbsent = managed !== undefined && !entries.includes(managed);
  return managedWasAbsent
    ? [managed, ...additions, ...appended]
    : [...additions, ...appended];
}

// ---------------------------------------------------------------------------
// 登录 shell PATH 的重新取回（宿主注入）
// ---------------------------------------------------------------------------

type LoginShellPathRehydrator = () => void;

let rehydrator: LoginShellPathRehydrator | undefined;

/**
 * 宿主把 `hydrateLoginShellPath` 交进来。
 *
 * ❌ 不从这里直接 import `electron/shellPath`：会话页与宿主是两个 bundle，跨过去只会拿到
 * 复制品，而那个模块**有模块级状态**（`lastLoginShellPath`，报错时要靠它说明「当时 PATH 补
 * 没补上」）。复制品里的记录宿主永远读不到。
 */
export function setLoginShellPathRehydrator(fn: LoginShellPathRehydrator | undefined): void {
  rehydrator = fn;
}

/**
 * 重新取一次用户登录 shell 的 PATH。
 *
 * 为什么装完要做：安装脚本自己挑目录、再往用户的 rc 文件追加 PATH，是完全正当的做法
 * （实测 36 个 agent 里 15 个走脚本安装，mimo 落 `~/.mimocode/bin`、grok 落 `~/.grok/bin`）。
 * 而咕咕的 PATH 是**启动时**取的一次快照 —— rc 刚被改过，快照就过期了。于是「装成功了、
 * 当场探测不到、报安装后未检测到」，重启咕咕才看得见，没人猜得到要重启。
 *
 * ❌ 不给某个 agent 加特例目录：那是白名单，下一个 agent 挑个新目录又坏。rc 是安装脚本
 * 与 shell 之间的既有约定，咕咕重新读一次即可，与安装方式无关。
 *
 * 两条失败路径都**出声**，❌ 不静默：
 *   · 没注入 = 宿主↔会话页的接线断了。它不该让安装流程失败，但静默 no-op 会让这一整条修复
 *     悄悄失效、症状与修之前一模一样(装成功、当场找不到)，无从分辨。这一行也是这条接线
 *     唯一能从外部验证的读数。
 *   · 探测 shell 抛错 = 继续用启动时那份，属于降级不是失败。
 */
export function rehydrateLoginShellPath(): void {
  if (!rehydrator) {
    log.warn(
      '[userEnv] 装完本该重新读一次登录 shell 的 PATH，但宿主没有注入实现 —— ' +
        '安装脚本刚写进用户 rc 的目录这一轮不会被看见（症状：装成功却报"安装后未检测到"）。' +
        '接线在 main.ts 的 setLoginShellPathRehydrator。'
    );
    return;
  }
  try {
    rehydrator();
    log.info('[userEnv] 装完已重新读取登录 shell 的 PATH');
  } catch (error: unknown) {
    log.warn(
      `[userEnv] 重新读取登录 shell PATH 失败，继续使用启动时的那份: ${String(error)}`
    );
  }
}

// ---------------------------------------------------------------------------
// 登录 shell 环境快照（宿主注入，#5873）
// ---------------------------------------------------------------------------

type LoginShellEnvProvider = () => Record<string, string> | null;

let loginShellEnvProvider: LoginShellEnvProvider | undefined;
let warnedMissingLoginShellEnvProvider = false;

/**
 * 宿主把 `loginShellEnvSnapshot` 交进来。
 *
 * ❌ 不从这里直接 import `electron/shellPath`：理由与 `setLoginShellPathRehydrator` 一字不差 ——
 * 会话页与宿主是两个 bundle，那个模块**有模块级状态**（快照本身就存在它的模块变量里），
 * 跨过去只会拿到一份永远是空的复制品，症状与不修一模一样（会话里还是没有用户的 key）。
 */
export function setLoginShellEnvProvider(fn: LoginShellEnvProvider | undefined): void {
  loginShellEnvProvider = fn;
}

/**
 * 用户登录 shell 的环境快照；Windows / 采样失败 / 宿主没接线时是 null。
 *
 * 返回 null **不是**错误路径的同义词：Windows 上本来就没有登录 shell，用户环境块由系统交给
 * GUI 进程，`buildUserShellBaseEnv` 在那边直接用 `process.env`。所以只在 POSIX 上出声，
 * 且只出一次 —— 这个函数每起一条会话都会被调用。
 */
export function loginShellEnv(): Record<string, string> | null {
  if (loginShellEnvProvider) return loginShellEnvProvider();
  if (process.platform !== 'win32' && !warnedMissingLoginShellEnvProvider) {
    warnedMissingLoginShellEnvProvider = true;
    log.warn(
      '[userEnv] 宿主没有注入登录 shell 环境快照 —— 用户写在 ~/.zshrc 里的 API key / 代理' +
        '这一轮到不了任何会话（症状：终端里跑得通、任务页里报 Missing environment variable）。' +
        '接线在 main.ts 的 setLoginShellEnvProvider。'
    );
  }
  return null;
}

