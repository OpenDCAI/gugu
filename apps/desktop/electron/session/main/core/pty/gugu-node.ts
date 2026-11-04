/**
 * `gugu-node` —— 咕咕自带的 Node,摆在每个 agent 的 PATH 上:App 的 skill 带的脚本、agent 自己要跑的 .mjs 都跑在它上面,
 * 谁都不用另装 Node。
 *
 * agent 的 shell 里原本没有能指望的运行时:buildAgentEnv 不给 node,用户 shell 里的 `ELECTRON_*` / `GUGU_*` 被剥掉
 * (childProcessEnv.ts),咕咕经 mise 装的那份 node 不在 PATH 上(也只有装过 npm 形态的 agent 才有)。可咕咕自己一直带着
 * 一份:桌面是自己的可执行文件按 node 跑(`ELECTRON_RUN_AS_NODE`;runAsNode 是承重的,见 devtools-lock.ts),server 是
 * 包里的官方 node(scripts/build/build-gugu-server.mjs)。
 *
 *  · 叫 `gugu-node`,❌ 叫 `node`:它的目录排在 PATH 最前,同名就遮住用户自己的 node。
 *  · 每次启动重写(server-browser-env.ts 的 writeHelperScripts,与 gugu-browser 同一个写法):更新后可执行文件换了地方,
 *    Linux AppImage 的挂载点每次都不同。
 *  · Windows 两份:`gugu-node.cmd` 给 PowerShell / cmd;无后缀的 sh 给 Git Bash(Claude Code 在 Windows 上的 shell),
 *    它按裸名字找不到 .cmd(npm 也是两份)。.cmd 里的路径怎么写见 windowsCmd。
 *  · ELECTRON_RUN_AS_NODE 照常传给它起的子进程:脚本按 process.execPath 再起自己(tsx、nodemon、`-e`)起来的才仍是 node。
 *    代价:它起的别的 Electron 程序(VS Code……)也按 node 跑,那时要从子进程的环境里去掉这个变量(评审 0f4766613c:
 *    先前用预载删掉它,再起自己就成了 Electron App,`-e` 挂住、tsx 挂住还留孤儿)。
 *  · 放哪:桌面 `<GUGU_HOME>/bin`,咕咕自己的助手目录 —— ❌ mise-bin:那里的每个文件都被认作 mise 装的 agent
 *    (method-detection.ts 的 ownedMiseBinDirs)。server 是现成的 `<GUGU_SERVER_HOME>/bin`(server-browser-env.ts 的助手
 *    也在那),指向 `current` 里的那份 node:一台机器上几个账号进程共用这个目录、版本可能各不相同,`current` 是一直在的那份。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveGuguHome } from '@gugu/core';
import { quoteShellArg } from '@main/utils/shellEscape';
import { type HelperFs, pathWithFirst, writeHelperScripts } from './server-browser-env';

export const GUGU_NODE = 'gugu-node';

/** 脚本里那行说明。批处理按控制台的 OEM 代码页读,所以只用 ASCII。 */
const NOTE = "gugu's own Node. gugu rewrites this file at every start: a change here does not last.";

const isAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

/**
 * 脚本的正文,按文件名。`node` = 按 node 跑的那个可执行文件;`electron` = 它是 Electron(桌面上的咕咕自己):设
 * ELECTRON_RUN_AS_NODE 让它按 node 跑。真 node(server)不设。
 */
export function guguNodeScripts(node: string, platform: NodeJS.Platform, electron: boolean): Record<string, string> {
  const sh = (target: string) =>
    [
      '#!/bin/sh',
      `# ${NOTE}`,
      ...(electron ? ['ELECTRON_RUN_AS_NODE=1', 'export ELECTRON_RUN_AS_NODE'] : []),
      `exec ${quoteShellArg(target)} "$@"`,
      '',
    ].join('\n');
  if (platform !== 'win32') return { [GUGU_NODE]: sh(node) };
  return {
    [`${GUGU_NODE}.cmd`]: windowsCmd(node, electron),
    // Git Bash 认 `C:/…` 这种写法,按 UTF-8 读脚本;参数里的 /c/… 由它在起 Windows 程序时自己换成 C:\…。
    [GUGU_NODE]: sh(node.replaceAll('\\', '/')),
  };
}

/**
 * 路径写绝对的。❌ `%~dp0`:cmd 里带引号按裸名调用(`"gugu-node"`)时它展开成当前目录(评审 0f4766613c)。
 * 批处理按控制台的 OEM 代码页(中文 936、英文 437)读:UTF-8 写的非 ASCII 路径读出来是乱码,「系统找不到指定的路径」
 * (Windows 实测)⇒ 路径里有非 ASCII(中文用户名下的按用户安装、装在中文目录里)就临时切到 UTF-8 读那一行,跑完切回去。
 * `%` 在批处理里写成 `%%`;批处理会等 GUI 子系统的程序跑完,退出码随最后一条命令带回。
 *
 * 程序那一行 ❌ 接着写收尾(`& …`):参数里引号不成对时,`%*` 后面的整段都会被吞进引号、当成参数交给程序(Windows 实测)。
 * 代价:程序跑着时启动器被换成内容不同的一份(只在可执行文件换了路径时;内容一样不重写,见 writeHelperScripts),
 * 程序一回来 cmd 会从老偏移接着读新文件。
 */
function windowsCmd(node: string, electron: boolean): string {
  const env = electron ? ['set ELECTRON_RUN_AS_NODE=1'] : [];
  const run = `"${node.replaceAll('%', '%%')}" %*`;
  const lines = ['@echo off', `rem ${NOTE}`, 'setlocal'];
  if (isAscii(node)) {
    lines.push(...env, run);
  } else {
    lines.push(
      `for /f "tokens=2 delims=:." %%c in ('chcp') do set "gugu_cp=%%c"`,
      'chcp 65001 >nul',
      ...env,
      run,
      'set gugu_rc=%ERRORLEVEL%',
      'chcp %gugu_cp% >nul',
      'exit /b %gugu_rc%',
    );
  }
  return [...lines, ''].join('\r\n');
}

/**
 * 这个进程的 `gugu-node` 放哪、指向谁、是不是 Electron。server 模式(有 `GUGU_SERVER_HOME`)放进它的助手目录,其余放
 * `<GUGU_HOME>/bin` —— GUGU_HOME 按渠道各一份(main.ts 的 @@@home-unify:正式版 ~/.gugu,别的档 ~/.gugu-<档>,指定
 * user-data-dir 的实例在它自己里面),所以正式版与 Beta 的启动器各指各的可执行文件,卸掉一个不牵连另一个。
 */
export function guguNodeTarget(
  env: NodeJS.ProcessEnv,
  execPath: string,
  fsImpl: Pick<typeof fs, 'existsSync'> = fs,
  electron: boolean = Boolean(process.versions.electron),
): { dir: string; node: string; electron: boolean } {
  const serverHome = env.GUGU_SERVER_HOME?.trim();
  if (serverHome) {
    // 装好的机器上是 current 里的那份真 node;开发构建(没有 current)就是在跑的这个。
    const installed = path.join(serverHome, 'current', 'node', 'bin', 'node');
    const dir = path.join(serverHome, 'bin');
    return fsImpl.existsSync(installed) ? { dir, node: installed, electron: false } : { dir, node: execPath, electron };
  }
  return { dir: path.join(resolveGuguHome(env), 'bin'), node: execPath, electron };
}

let installedDir: string | null = null;

/** 写上并记下目录,之后起的 agent 都带上它。返回目录。 */
export function installGuguNode(options: {
  dir: string;
  node: string;
  electron: boolean;
  platform?: NodeJS.Platform;
  fsImpl?: HelperFs;
}): string {
  writeHelperScripts(options.dir, guguNodeScripts(options.node, options.platform ?? process.platform, options.electron), options.fsImpl);
  setGuguNodeDir(options.dir);
  return options.dir;
}

/** 记下(或清掉)`gugu-node` 所在的目录;同 setServerBrowserHelpers。 */
export function setGuguNodeDir(dir: string | null): void {
  installedDir = dir;
}

/** 起 agent 时叠上去的 PATH:助手目录排最前(已在里面就挪到最前);没装 = 空。 */
export function guguNodeEnv(basePath: string | undefined, delimiter: string = path.delimiter): Record<string, string> {
  return installedDir ? { PATH: pathWithFirst(installedDir, basePath, delimiter) } : {};
}
