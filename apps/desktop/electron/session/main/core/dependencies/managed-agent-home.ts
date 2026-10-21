import os from 'node:os';
import path from 'node:path';
import { resolveGuguHome } from '@gugu/core';
import type { Platform } from '@gugu/session-core/deps';

/**
 * 咕咕自己拥有的 agent 安装位置。
 *
 * 在此之前,「装在哪」和「跑哪个」两件事都外包给了用户环境:装,是让用户的 npm 装进用户的
 * 全局 prefix;跑,是拿用户登录 shell 的 PATH 去 `which`。两者只在用户环境恰好配对时才重合,
 * 而这个前提咕咕既不能保证也无法检测 —— 于是出现了三种都被真机复现过的失败:
 *
 *   1. 装成功、版本不变。用户在别处还有一份(codex 官方安装脚本默认落 `~/.local/bin`),
 *      它在登录 shell 的 PATH 里排得更靠前,于是 npm 装的新版永远被遮住。#4271
 *   2. 装不进去。用户的 npm 全局 bin 目录被另一个包管理器占着(homebrew cask 的软链),
 *      npm 拒绝覆盖不属于它的文件,`EEXIST`,重试多少次都一样。
 *   3. 装了一半的残骸把后续安装永久堵死。#4246
 *
 * 换成咕咕自己的目录之后,这三条的**结构性前提**就没有了:落点确定、只有咕咕写、解析时排第一。
 * 镜像源随之退化成一个纯粹的 `--registry` 参数 —— 装到哪、生不生效都与它无关,这对没有梯子、
 * 只能靠镜像源的用户是决定性的:点一次就该成。
 *
 * ❌ 不接管用户已经装好的副本:它们照常被枚举、照常可选,只是不再是咕咕能否装成功的前提。
 * 跟着 `GUGU_HOME` 走,所以隔离开发实例、beta、正式版天然各用各的(见 main.ts 的 @@@home-unify)。
 */
export function managedAgentPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveGuguHome(env), 'agents');
}

/** Stable application entrypoints into mise's versioned installations. */
export function managedMiseBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(managedAgentPrefix(env), 'mise-bin');
}

/**
 * npm 把可执行文件放在哪:POSIX 是 `<prefix>/bin`,Windows 直接放 `<prefix>` 根目录
 * (`.cmd` / `.ps1` shim)。写错平台的后果不是报错,是解析永远落空 —— 装了却"找不到"。
 */
export function managedAgentBinDir(
  platform: Platform = currentPlatform(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const prefix = managedAgentPrefix(env);
  return platform === 'windows' ? prefix : path.join(prefix, 'bin');
}

/**
 * 咕咕自己那棵 npm 树的根。npm 在 POSIX 上放 `<prefix>/lib/node_modules`,Windows 上放
 * `<prefix>/node_modules`。探测器拿它把「我们自己装的那份」判成 **confirmed** —— 不是猜,
 * 是我们亲手放的;而 `npm root -g` 答的是用户那个 prefix,永远找不到这里。
 */
export function managedAgentNpmRoot(
  platform: Platform = currentPlatform(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const prefix = managedAgentPrefix(env);
  return platform === 'windows'
    ? path.join(prefix, 'node_modules')
    : path.join(prefix, 'lib', 'node_modules');
}

function currentPlatform(): Platform {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

/** 供 PATH 前置使用的目录清单:咕咕自己的在前,历史遗留的 `~/.local/bin` 在后。 */
export function agentBinDirsInPriorityOrder(
  platform: Platform = currentPlatform(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [managedMiseBinDir(env), managedAgentBinDir(platform, env), path.join(homeDir(env), '.local', 'bin')];
}

function homeDir(env: NodeJS.ProcessEnv): string {
  // @@@win-home — Windows 不设 HOME，用 USERPROFILE；os.homedir() 是最后兜底。
  return env.USERPROFILE?.trim() || env.HOME?.trim() || os.homedir();
}

/**
 * 各家**官方安装器**的标准落点。
 *
 * 为什么要有这张表：很多用户是先照官网装好 CLI、才来用咕咕的。而咕咕发现已有副本靠的是
 * `where` / `which`，也就是**用户 PATH 里有没有** —— 那是用户环境里最不稳的一件东西：
 * 安装器把目录写进注册表/rc 之后，咕咕这个已经启动的进程拿到的仍是旧快照；用户「装完了
 * 回到咕咕」，产品却告诉他「你没装」，于是他被要求再装一遍，装出来的第二份还会和第一份打架。
 *
 * ⚠️ 这些目录**追加在 PATH 末尾**，❌ 不前置：前置会改变「谁先被找到」，把用户自己
 * PATH 里那一份顶掉（product spec「面板显示哪一份就启动哪一份」）。
 * 追加只做一件事 —— 让原本压根看不见的那一份变得看得见。
 *
 * 每一条都要是**实地见过的**落点，❌ 不许凭印象凑：
 * - `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` —— codex 官方 Windows 安装器
 *   （`install.ps1` 里的 `$defaultVisibleBinDir`；2026-09-16 在用户机器截图上确认一致）
 * - `%APPDATA%\npm` —— Windows 上 npm 的全局 bin 默认位置（用户自己 `npm i -g` 装的那种）
 * - `~/.bun/bin`、`~/.cargo/bin` —— bun / cargo 装的 CLI
 * - `/opt/homebrew/bin`、`/usr/local/bin` —— macOS 上 Homebrew 的两种前缀（Apple Silicon / Intel）
 * - `/Applications/ChatGPT.app/Contents/Resources` —— **codex 的桌面版已并入 ChatGPT 桌面端**，
 *   CLI 就躺在这个应用包里（owner 机器实测：`codex-cli 0.153.4`，比他 PATH 上那份 0.145.0 还新）。
 *   ❌ 别按品牌名去找 `Codex.app` —— 厂商合并产品线之后那个名字根本不存在，2026-09-17 就是这么漏掉的。
 */
export function vendorInstallDirs(
  platform: Platform = currentPlatform(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const home = homeDir(env);
  if (platform === 'windows') {
    const localAppData = env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local');
    const appData = env.APPDATA?.trim() || path.join(home, 'AppData', 'Roaming');
    return [
      path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'),
      path.join(appData, 'npm'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.cargo', 'bin'),
    ];
  }
  const dirs = [
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  // 应用包内部只在 macOS 有意义。追加在末尾这一点在这里尤其要紧:这个目录里除了 codex
  // 还躺着一份 `rg`,前置就会拿厂商捆绑的版本顶掉用户自己装的那个。
  if (platform === 'macos') {
    dirs.push('/Applications/ChatGPT.app/Contents/Resources');
  }
  return dirs;
}
