/**
 * 宿主声明「这一家经 node 起」(`runtimeCompatibility.runtime: 'node'`)时,命令被改写成
 * `node <harness 路径> …`。那个路径必须是 **JS 入口**,不是壳(#6390)。
 *
 * 现场(2026-09-24 Windows 真机):pi 的托管入口是 `…\agents\mise-bin\pi.cmd`,
 * node 把它当 CommonJS 解析,第一行 `@echo off` 就 `SyntaxError: Invalid or unexpected token`,
 * pi 的 Code/终端腿一条都开不起来。
 *
 * 壳是一条链:咕咕自己的 launcher 只一行转到 npm 的 `.bin\pi.cmd`,npm 的壳里才写着
 * `node "…\cli.js" %*`(以及同一脚本的 `"%~dp0\node.exe" "…\cli.js" %*` 分支)。沿链读到那个 `.js`。
 * 读不出来返回 null —— 调用方响亮失败,❌ 把壳喂给 node。
 *
 * ⚠️ 本模块**不许有 `node:` 导入**:它经 agents/plugins 的 barrel 进了 web 构建(renderer 的
 * web target 会把 `node:*` 外置成空壳,具名导入当场构建失败)。读盘由调用方注入 ——
 * node 侧用 `windows-launcher.ts` 的 `diskWindowsShimReader`。路径运算因此也在这里自己做。
 */

/** 读壳与判存在的那一对;读不到返回 null。 */
export type WindowsShimReader = {
  readShim: (shimPath: string) => string | null;
  exists: (candidate: string) => boolean;
};

export type WindowsNodeScriptLaunch = {
  node: string;
  entry: string;
  /** 壳给子进程设的环境变量(aube 的 `NODE_PATH`);不经壳直接起时要原样带上。 */
  env: Record<string, string>;
};

/** 一行只转给另一个壳:`"%~dp0..\…\pi.cmd" %*`。 */
const CMD_SHIM_FORWARD_TO_SHIM = /^\s*"([^"\r\n]+\.(?:cmd|bat))"\s+%\*\s*$/im;

/** npm cmd-shim 的「用 node 跑这个脚本」:`node "…\cli.js" %*` 或 `"%~dp0\node.exe" "…\cli.js" %*`。 */
const CMD_SHIM_NODE_SCRIPT =
  /^\s*(?:"[^"\r\n]*\\node(?:\.exe)?"|node(?:\.exe)?)\s+"([^"\r\n]+\.[cm]?js)"\s+%\*\s*$/im;

/** npm 新版 cmd-shim 通过 `_prog` 变量保存 node.exe，再在 endLocal 行调用它。 */
const CMD_SHIM_VARIABLE_SCRIPT =
  /"?((?:%[A-Za-z_][A-Za-z0-9_]*%|node(?:\.exe)?|[^"\r\n]*\\node(?:\.exe)?))"?\s+"([^"\r\n]+\.[cm]?js)"\s+%\*/im;

/** 壳链最多追几层:咕咕 launcher → npm 壳是两层,多留一层余量;再深就是环了。 */
const MAX_SHIM_HOPS = 4;

function windowsExtname(p: string): string {
  const base = p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

function windowsDirname(p: string): string {
  return p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));
}

/** 折叠 `.` / `..` 与重复分隔符;盘符、UNC 前缀与根(`\foo`)原样保留。 */
function windowsNormalize(p: string): string {
  const root = p.startsWith('\\\\') ? '\\\\' : /^[\\/]/.test(p) ? '\\' : '';
  const parts = p.split(/[\\/]+/).filter((part, i) => part !== '' || i === 0);
  const out: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..' && out.length > 1) { out.pop(); continue; }
    out.push(part);
  }
  return root + out.filter((part) => part !== '').join('\\');
}

/** 壳里的 `%dp0%` / `%~dp0` = 壳自己所在目录(带尾分隔符)。 */
function expandShimDirectory(template: string, shimPath: string): string {
  return template.replace(/%~?dp0%?/gi, `${windowsDirname(shimPath)}\\`);
}

/**
 * 壳里的 `SET`。上游生成器写的只有这几个名字(npm cmd-shim 3–9、pnpm 的 @zkochan/cmd-shim、aube 2.2、咕咕的启动器):
 * · `dp0` / `_prog` 只在壳里用。
 * · `PATHEXT` 去掉 `.JS`,只为让裸名 `node` 别解析到 `node.js` 文件;不经壳时 node 由调用方解析成 `.exe`。
 * · `NODE_PATH`(aube 默认写)改的是子进程的模块解析 ⇒ 带进 `env`。
 * · `PATH` 只有咕咕的启动器写(`<咕咕那份 node 的目录>;%PATH%`),它的用途是让 npm 壳找到 node(mise-installer.ts 的
 *   `managedLauncher`);agent 起的子进程用的是 gugu-node(pty/gugu-node.ts)⇒ 这里只用它解析 node。
 * 出现别的名字,或值不是上面的形状 = 这份壳认不全 ⇒ null,调用方照旧起壳。
 */
const SHIM_SET = /(?:^|&)\s*@?SET\s+(?:"([^="\r\n]+)=([^"\r\n]*)"|([^="\s&]+)=([^&\r\n]*))/gim;

type ShimSets = { variables: Map<string, string>; pathPin?: string; nodePath?: string };

function readShimSets(text: string, shimPath: string): ShimSets | null {
  const sets: ShimSets = { variables: new Map() };
  for (const match of text.matchAll(SHIM_SET)) {
    const key = (match[1] ?? match[3])!.toLowerCase();
    const raw = expandShimDirectory((match[2] ?? match[4])!.trim(), shimPath);
    if (key === 'pathext') continue;
    if (key === 'path') {
      const pin = /^([^%;]+);%PATH%$/i.exec(raw)?.[1];
      if (!pin) return null;
      sets.pathPin = windowsNormalize(pin);
    } else if (key === 'node_path') {
      if (raw.includes('%')) return null;
      sets.nodePath = raw.split(';').map(windowsNormalize).join(';');
    } else if (key === 'dp0' || key === '_prog') {
      const value = windowsNormalize(raw);
      // npm 的 shim 同时写入「同目录 node.exe」和 PATH 回退 `node`；保留前者，避免把
      // 可直接 spawn 的解释器误降级成需要再次解析 PATH 的裸名称。
      if (!sets.variables.has(key) || value.toLowerCase() !== 'node') sets.variables.set(key, value);
    } else {
      return null;
    }
  }
  return sets;
}

function resolveShimNode(token: string, variables: Map<string, string>, shimPath: string): string {
  const variable = /^%([^%]+)%$/.exec(token);
  const value = variable ? variables.get(variable[1]!.toLowerCase()) : token;
  const expanded = expandShimDirectory(value ?? token, shimPath);
  return expanded.toLowerCase() === 'node' || expanded.toLowerCase() === 'node.exe'
    ? expanded
    : windowsNormalize(expanded);
}

function parseWindowsNodeScriptLaunch(
  shimPath: string,
  text: string,
  variables: Map<string, string>
): Omit<WindowsNodeScriptLaunch, 'env'> | null {
  const direct = CMD_SHIM_NODE_SCRIPT.exec(text);
  if (direct) {
    const nodeMatch = /(?:"([^"\r\n]*\\node(?:\.exe)?)"|\b(node(?:\.exe)?))\s+"/.exec(direct[0]);
    const node = nodeMatch?.[1] ?? nodeMatch?.[2];
    if (!node) return null;
    return {
      node: resolveShimNode(node, variables, shimPath),
      entry: windowsNormalize(expandShimDirectory(direct[1]!, shimPath)),
    };
  }

  const variable = CMD_SHIM_VARIABLE_SCRIPT.exec(text);
  if (!variable) return null;
  return {
    node: resolveShimNode(variable[1]!, variables, shimPath),
    entry: windowsNormalize(expandShimDirectory(variable[2]!, shimPath)),
  };
}

/**
 * POSIX 上的同一个现场(2026-10-07 mac1):咕咕托管的 pi 入口 `…/agents/mise-bin/pi` 是咕咕自己写的 sh 启动器
 * (`mise-installer.ts` 的 `managedLauncher`),`node <它>` 第二行 `# gugu-release:` 就 SyntaxError。
 *
 *   #!/bin/sh
 *   # gugu-release: 1.0.4
 *   PATH='<咕咕那份 node 的 bin 目录>':"$PATH"
 *   export PATH
 *   exec '<npm 的 node_modules/.bin/pi>' "$@"
 *
 * 它 exec 的 npm `.bin/pi` 也不是 JS:是 aube(mise 的 npm 后端)写的 sh 壳,第二行自报目标,
 * `# aube-bin-shim v2 target=../.mise/…/dist/bundle/cli.js`(相对壳所在目录),那个 `cli.js` 才是入口。
 *
 * 沿链读到第一个不是 sh 脚本的文件,并带上启动器钉的那份 node —— 没装 node 的机器上,能跑这一家的只有那份。
 * 一开始就不是 sh 脚本 = 原样交出(用户自己装的本来就是 JS 入口);链上某个 sh 脚本读不出下一跳 = null,
 * 调用方响亮失败,❌ 把脚本交给 node。
 */
const POSIX_LAUNCHER_EXEC = /^exec '([^']+)'/m;
const POSIX_LAUNCHER_PATH = /^PATH='([^']+)':"\$PATH"$/m;
const AUBE_SHIM_TARGET = /^# aube-bin-shim v\d+ target=(.+)$/m;

/** `dir` 下的 `rel`(或绝对的 `rel`),折叠 `.` / `..`。 */
function posixResolve(dir: string, rel: string): string {
  const out: string[] = [];
  for (const part of (rel.startsWith('/') ? rel : `${dir}/${rel}`).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return `/${out.join('/')}`;
}

export function resolvePosixNodeScriptEntry(
  command: string,
  reader: WindowsShimReader
): { entry: string; node?: string } | null {
  let current = command;
  let node: string | undefined;
  for (let hop = 0; hop <= MAX_SHIM_HOPS; hop++) {
    const text = reader.readShim(current);
    if (text === null || !text.startsWith('#!/bin/sh')) return node ? { entry: current, node } : { entry: current };
    const nodeDir = node ? undefined : POSIX_LAUNCHER_PATH.exec(text)?.[1];
    if (nodeDir && reader.exists(`${nodeDir}/node`)) node = `${nodeDir}/node`;
    const aubeTarget = AUBE_SHIM_TARGET.exec(text)?.[1];
    const next = POSIX_LAUNCHER_EXEC.exec(text)?.[1]
      ?? (aubeTarget ? posixResolve(current.slice(0, current.lastIndexOf('/')), aubeTarget) : undefined);
    if (!next || !reader.exists(next)) return null;
    current = next;
  }
  return null;
}

export function resolveWindowsNodeScriptEntry(
  command: string,
  options: { platform: string; reader: WindowsShimReader }
): string | null {
  return resolveWindowsNodeScriptLaunch(command, options)?.entry ?? null;
}

export function resolveWindowsNodeScriptLaunch(
  command: string,
  options: { platform: string; reader: WindowsShimReader }
): WindowsNodeScriptLaunch | null {
  if (options.platform !== 'win32') return { node: 'node', entry: command, env: {} };

  const { exists } = options.reader;
  const env: Record<string, string> = {};
  let pathPin: string | undefined;
  let current = command;
  for (let hop = 0; hop <= MAX_SHIM_HOPS; hop += 1) {
    const extension = windowsExtname(current);
    if (extension === '.js' || extension === '.cjs' || extension === '.mjs') {
      return exists(current) ? { node: 'node', entry: current, env } : null;
    }
    if (extension !== '.cmd' && extension !== '.bat') return null;

    const text = options.reader.readShim(current);
    if (!text) return null;
    const sets = readShimSets(text, current);
    if (!sets) return null;
    pathPin = sets.pathPin ?? pathPin;
    if (sets.nodePath) env.NODE_PATH = sets.nodePath;
    const script = parseWindowsNodeScriptLaunch(current, text, sets.variables);
    if (script && exists(script.entry)) {
      // 壳自己用 `IF EXIST "%dp0%\node.exe"` 在同目录 node.exe 和 PATH 上的 `node` 之间选:官方安装包装的 Node,
      // `%AppData%\npm` 旁边没有 node.exe ⇒ 照壳的 ELSE 走 PATH,❌ 交出一条不存在的解释器路径。
      const node = /\\/.test(script.node) && !exists(script.node) ? 'node' : script.node;
      // 走 PATH 时,前一跳的咕咕启动器已经把咕咕那份 node 的目录钉在 PATH 最前:cmd 找到的就是那一份。
      const pinned = pathPin && /^node(?:\.exe)?$/i.test(node) ? `${pathPin}\\node.exe` : undefined;
      return { node: pinned && exists(pinned) ? pinned : node, entry: script.entry, env };
    }
    const forward = script ? null : CMD_SHIM_FORWARD_TO_SHIM.exec(text);
    const next = forward?.[1];
    if (!next) return null;
    current = windowsNormalize(expandShimDirectory(next, current));
  }
  return null;
}
