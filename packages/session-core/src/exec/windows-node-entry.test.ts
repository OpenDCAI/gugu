import { describe, expect, it } from 'vitest';
import { resolveWindowsNodeScriptEntry, resolveWindowsNodeScriptLaunch } from './windows-node-entry';

/**
 * #6390:声明 `runtime: 'node'` 的家在 Windows 上被改写成 `node <harness>`,而 harness 是 `.cmd` 壳 ⇒
 * node 把批处理当 JS 解析,`SyntaxError`。这里钉「沿壳链读到真正的 JS 入口」。
 *
 * 两份壳的正文逐字取自 2026-09-24 Windows 真机(咕咕 Beta 托管安装的 pi 0.87.1)。
 */
const HOME = 'C:\\Users\\u\\.gugu-beta\\agents';
const LAUNCHER = `${HOME}\\mise-bin\\pi.cmd`;
const INSTALL = `${HOME}\\mise\\data\\installs\\npm-earendil-works-pi-coding-agent\\0.87.1`;
const NPM_SHIM = `${INSTALL}\\node_modules\\.bin\\pi.cmd`;
const ENTRY = `${INSTALL}\\node_modules\\.mise\\@earendil-works+pi-coding-agent@0.87.1\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js`;
const CODEX_SHIM = 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd';
const CODEX_NODE = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node.exe';
const CODEX_ENTRY = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';

const LAUNCHER_TEXT = [
  '@echo off',
  'set "PATH=%~dp0..\\mise\\data\\installs\\node\\24.21.0;%PATH%"',
  '"%~dp0..\\mise\\data\\installs\\npm-earendil-works-pi-coding-agent\\0.87.1\\node_modules\\.bin\\pi.cmd" %*',
  '',
].join('\r\n');

const NPM_SHIM_TEXT = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe" "%~dp0\\..\\.mise\\@earendil-works+pi-coding-agent@0.87.1\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*',
  ') ELSE (',
  '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
  '  node "%~dp0\\..\\.mise\\@earendil-works+pi-coding-agent@0.87.1\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*',
  ')',
  '',
].join('\r\n');

const CODEX_SHIM_TEXT = [
  '@ECHO off',
  'SETLOCAL',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  ')',
  'endLocal & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');

function fs(files: Record<string, string>) {
  const lower = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    platform: 'win32',
    reader: {
      readShim: (p: string) => lower.get(p.toLowerCase()) ?? null,
      exists: (p: string) => lower.has(p.toLowerCase()),
    },
  };
}

describe('resolveWindowsNodeScriptEntry', () => {
  it('咕咕 launcher → npm 壳 → cli.js,两跳读到真入口', () => {
    const resolved = resolveWindowsNodeScriptEntry(
      LAUNCHER,
      fs({ [LAUNCHER]: LAUNCHER_TEXT, [NPM_SHIM]: NPM_SHIM_TEXT, [ENTRY]: '#!/usr/bin/env node' })
    );
    expect(resolved).toBe(ENTRY);
  });

  it('直接给 npm 壳也读得到', () => {
    expect(resolveWindowsNodeScriptEntry(NPM_SHIM, fs({ [NPM_SHIM]: NPM_SHIM_TEXT, [ENTRY]: '' }))).toBe(ENTRY);
  });

  it('解析新版 npm cmd-shim 的 node.exe 与脚本入口', () => {
    expect(resolveWindowsNodeScriptLaunch(CODEX_SHIM, fs({
      [CODEX_SHIM]: CODEX_SHIM_TEXT,
      [CODEX_NODE]: '',
      [CODEX_ENTRY]: '',
    }))).toEqual({ node: CODEX_NODE, entry: CODEX_ENTRY, env: {} });
  });

  it('壳旁边没有 node.exe(官方安装包装的 Node)⇒ 照壳的 ELSE 用 PATH 上的 node', () => {
    expect(resolveWindowsNodeScriptLaunch(CODEX_SHIM, fs({
      [CODEX_SHIM]: CODEX_SHIM_TEXT,
      [CODEX_ENTRY]: '',
    }))).toEqual({ node: 'node', entry: CODEX_ENTRY, env: {} });
  });

  it('入口文件不在盘上 ⇒ null,❌ 交出一条不存在的路径', () => {
    expect(
      resolveWindowsNodeScriptEntry(LAUNCHER, fs({ [LAUNCHER]: LAUNCHER_TEXT, [NPM_SHIM]: NPM_SHIM_TEXT }))
    ).toBeNull();
  });

  it('壳里跑的是原生 exe(不是 node 脚本)⇒ null', () => {
    const shim = 'C:\\bin\\claude.cmd';
    expect(
      resolveWindowsNodeScriptEntry(shim, fs({ [shim]: '@ECHO off\r\n"%dp0%\\node_modules\\x\\claude.exe"   %*\r\n' }))
    ).toBeNull();
  });

  it('读不到壳 ⇒ null', () => {
    expect(resolveWindowsNodeScriptEntry(LAUNCHER, fs({}))).toBeNull();
  });

  it('壳互相转发成环 ⇒ null,不死循环', () => {
    const a = 'C:\\bin\\a.cmd';
    const b = 'C:\\bin\\b.cmd';
    expect(
      resolveWindowsNodeScriptEntry(a, fs({ [a]: '"%~dp0b.cmd" %*\r\n', [b]: '"%~dp0a.cmd" %*\r\n' }))
    ).toBeNull();
  });

  it('本来就是 JS 入口 ⇒ 原样', () => {
    expect(resolveWindowsNodeScriptEntry(ENTRY, fs({ [ENTRY]: '' }))).toBe(ENTRY);
  });

  it('非 Windows 原样透传', () => {
    const never = { readShim: () => { throw new Error('must not read'); }, exists: () => false };
    expect(resolveWindowsNodeScriptEntry('/opt/bin/pi', { platform: 'darwin', reader: never })).toBe('/opt/bin/pi');
  });
});

/**
 * 上游生成器写出来的壳,逐字。npm cmd-shim 9.0.2 / 3.0.3 与 pnpm 的 @zkochan/cmd-shim 9.0.8:在 Linux 上对一个
 * `#!/usr/bin/env node` 的 `work/node_modules/pkg/bin/cli.js` 跑它们的导出函数,读回生成的 `.cmd`(2026-10-19)。
 * 托管 pi 那两份(咕咕的启动器 + aube 2.2.17 写的 `.bin` 壳)取自 Windows 真机 `~/.gugu-beta/agents`(2026-10-19)。
 */
const NPM_GLOBAL = 'C:\\Users\\u\\AppData\\Roaming\\npm';
const TOOL_SHIM = `${NPM_GLOBAL}\\tool.cmd`;
const TOOL_NODE = `${NPM_GLOBAL}\\node.exe`;
const TOOL_ENTRY = 'C:\\Users\\u\\AppData\\work\\node_modules\\pkg\\bin\\cli.js';
const UPSTREAM_SHIMS: Record<string, string[]> = {
  'npm cmd-shim 9.0.2': ["@ECHO off","GOTO start",":find_dp0","SET dp0=%~dp0","EXIT /b",":start","SETLOCAL","CALL :find_dp0","","IF EXIST \"%dp0%\\node.exe\" (","  SET \"_prog=%dp0%\\node.exe\"",") ELSE (","  SET \"_prog=node\"",")","","endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & \"%_prog%\"  \"%dp0%\\..\\..\\work\\node_modules\\pkg\\bin\\cli.js\" %*",""],
  'npm cmd-shim 3.0.3': ["@ECHO off","SETLOCAL","CALL :find_dp0","","IF EXIST \"%dp0%\\node.exe\" (","  SET \"_prog=%dp0%\\node.exe\"",") ELSE (","  SET \"_prog=node\"","  SET PATHEXT=%PATHEXT:;.JS;=;%",")","","\"%_prog%\"  \"%dp0%\\..\\..\\work\\node_modules\\pkg\\bin\\cli.js\" %*","ENDLOCAL","EXIT /b %errorlevel%",":find_dp0","SET dp0=%~dp0","EXIT /b",""],
  '@zkochan/cmd-shim 9.0.8': ["@SETLOCAL","@IF EXIST \"%~dp0\\node.exe\" (","  \"%~dp0\\node.exe\"  \"%~dp0\\..\\..\\work\\node_modules\\pkg\\bin\\cli.js\" %*",") ELSE (","  @SET PATHEXT=%PATHEXT:;.JS;=;%","  node  \"%~dp0\\..\\..\\work\\node_modules\\pkg\\bin\\cli.js\" %*",")",""],
};

const MANAGED_LAUNCHER_TEXT = ["@echo off","set \"PATH=%~dp0..\\mise\\data\\installs\\node\\24.21.0;%PATH%\"","\"%~dp0..\\mise\\data\\installs\\npm-earendil-works-pi-coding-agent\\0.87.1\\node_modules\\.bin\\pi.cmd\" %*",""].join('\r\n');
const AUBE_SHIM_TEXT = ["@SETLOCAL","@SET NODE_PATH=%~dp0..;%~dp0..\\.mise\\node_modules","@IF EXIST \"%~dp0\\node.exe\" (","  \"%~dp0\\node.exe\" \"%~dp0\\..\\.mise\\@earendil-works+pi-coding-agent@0.87.1\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js\" %*",") ELSE (","  @SET PATHEXT=%PATHEXT:;.JS;=;%","  node \"%~dp0\\..\\.mise\\@earendil-works+pi-coding-agent@0.87.1\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js\" %*",")",""].join('\r\n');
const MANAGED_NODE = `${HOME}\\mise\\data\\installs\\node\\24.21.0\\node.exe`;

describe('resolveWindowsNodeScriptLaunch:上游生成器的壳', () => {
  for (const [generator, lines] of Object.entries(UPSTREAM_SHIMS)) {
    const text = lines.join('\r\n');
    it(`${generator}:旁边有 node.exe 就用它`, () => {
      expect(resolveWindowsNodeScriptLaunch(TOOL_SHIM, fs({ [TOOL_SHIM]: text, [TOOL_NODE]: '', [TOOL_ENTRY]: '' })))
        .toEqual({ node: TOOL_NODE, entry: TOOL_ENTRY, env: {} });
    });
    it(`${generator}:旁边没有 ⇒ PATH 上的 node`, () => {
      expect(resolveWindowsNodeScriptLaunch(TOOL_SHIM, fs({ [TOOL_SHIM]: text, [TOOL_ENTRY]: '' })))
        .toEqual({ node: 'node', entry: TOOL_ENTRY, env: {} });
    });
  }

  it('咕咕托管:启动器钉的 node + aube 壳的 NODE_PATH 一起带出来', () => {
    expect(resolveWindowsNodeScriptLaunch(LAUNCHER, fs({
      [LAUNCHER]: MANAGED_LAUNCHER_TEXT,
      [NPM_SHIM]: AUBE_SHIM_TEXT,
      [MANAGED_NODE]: '',
      [ENTRY]: '',
    }))).toEqual({
      node: MANAGED_NODE,
      entry: ENTRY,
      env: { NODE_PATH: `${INSTALL}\\node_modules;${INSTALL}\\node_modules\\.mise\\node_modules` },
    });
  });

  it('启动器钉的目录里没有 node.exe ⇒ 不编一条路径,交回 PATH 上的 node', () => {
    expect(resolveWindowsNodeScriptLaunch(LAUNCHER, fs({
      [LAUNCHER]: MANAGED_LAUNCHER_TEXT,
      [NPM_SHIM]: AUBE_SHIM_TEXT,
      [ENTRY]: '',
    }))?.node).toBe('node');
  });

  // 阴控:三种认不全的壳,都必须交回 null(调用方照旧起壳)。
  it('壳还 SET 了别的变量 ⇒ null', () => {
    const text = AUBE_SHIM_TEXT.replace('@SETLOCAL\r\n', '@SETLOCAL\r\n@SET NODE_OPTIONS=--max-old-space-size=8192\r\n');
    expect(resolveWindowsNodeScriptLaunch(NPM_SHIM, fs({ [NPM_SHIM]: text, [ENTRY]: '' }))).toBeNull();
  });

  it('PATH 不是「一个目录;%PATH%」的形状 ⇒ null', () => {
    const text = MANAGED_LAUNCHER_TEXT.replace(';%PATH%', '');
    expect(resolveWindowsNodeScriptLaunch(LAUNCHER, fs({ [LAUNCHER]: text, [NPM_SHIM]: AUBE_SHIM_TEXT, [ENTRY]: '' })))
      .toBeNull();
  });

  // npm cmd-shim 9.0.2 对 `#!/usr/bin/env node --no-warnings` 生成的那一行:node 与脚本之间多了参数。
  it('shebang 带参数(node 与脚本之间还有东西)⇒ null', () => {
    const text = UPSTREAM_SHIMS['npm cmd-shim 9.0.2']!.join('\r\n')
      .replace('"%_prog%"  "', '"%_prog%" --no-warnings "');
    expect(resolveWindowsNodeScriptLaunch(TOOL_SHIM, fs({ [TOOL_SHIM]: text, [TOOL_ENTRY]: '' }))).toBeNull();
  });
});
