import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveLocalPtySpawn } from './pty-spawn-platform';

describe('resolveLocalPtySpawn platform branches', () => {
  it('uses ComSpec for the Windows interactive-shell branch', () => {
    expect(resolveLocalPtySpawn({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      intent: { kind: 'interactive-shell', cwd: 'C:\\repo' },
    })).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [],
      cwd: 'C:\\repo',
      warnings: [],
    });
  });

  it('uses SHELL for the macOS POSIX interactive-shell branch', () => {
    expect(resolveLocalPtySpawn({
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      intent: { kind: 'interactive-shell', cwd: '/repo' },
    })).toEqual({
      command: '/bin/zsh',
      args: ['-il'],
      cwd: '/repo',
      warnings: [],
    });
  });

  it('wraps a Linux argv command through the POSIX shell branch', () => {
    expect(resolveLocalPtySpawn({
      platform: 'linux',
      env: { SHELL: '/bin/bash' },
      intent: {
        kind: 'run-command',
        cwd: '/repo',
        command: { kind: 'argv', command: 'node', args: ['--version'] },
      },
    })).toEqual({
      command: '/bin/bash',
      args: ['-c', 'node --version'],
      cwd: '/repo',
      warnings: [],
    });
  });
});

describe('Windows .cmd shim spawn', () => {
  const WIN_ENV = { ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: '', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const CODEX = 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd';
  // 咕咕自己就在发这个参数(codex 的 code-mode 直调旋钮)。它带双引号,而双引号正是
  // 「自己拼一条 cmd.exe 命令行」会送坏的那一类 —— 真机量到的到达值是 `[^gugu]`。
  const QUOTED_ARG = 'features.code_mode.direct_only_tool_namespaces=["gugu"]';

  it('直接起 .cmd 壳,argv 原样交给 spawn 机制 —— ❌ 不自己拼 cmd.exe 命令行', () => {
    expect(resolveLocalPtySpawn({
      platform: 'win32',
      env: WIN_ENV,
      fileExists: (candidate) => candidate === CODEX,
      intent: {
        kind: 'run-command',
        cwd: 'C:\\repo',
        command: { kind: 'argv', command: CODEX, args: ['-c', QUOTED_ARG, 'resume', 'tid-1'] },
      },
    })).toEqual({
      command: CODEX,
      args: ['-c', QUOTED_ARG, 'resume', 'tid-1'],
      cwd: 'C:\\repo',
      warnings: [],
    });
  });

  // 用户把默认终端设成 PowerShell 时走的就是这一支 —— 真机上正是它把引号吃掉的那一条。
  it('默认终端是 PowerShell 也照样直接起 .cmd —— argv 不经过任何 shell', () => {
    expect(resolveLocalPtySpawn({
      platform: 'win32',
      env: WIN_ENV,
      fileExists: (candidate) => candidate === CODEX,
      intent: {
        kind: 'run-command',
        cwd: 'C:\\repo',
        command: { kind: 'argv', command: CODEX, args: ['-c', QUOTED_ARG, 'resume', 'tid-1'] },
        shellProfile: {
          id: 'pwsh',
          resolvedShellId: 'pwsh',
          resolvedFromSystem: true,
          executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          available: true,
          family: 'powershell',
          interactiveArgs: [],
          commandArgs: ['-NoLogo', '-Command'],
          envCaptureArgs: [],
        },
      },
    })).toEqual({
      command: CODEX,
      args: ['-c', QUOTED_ARG, 'resume', 'tid-1'],
      cwd: 'C:\\repo',
      warnings: [],
    });
  });

  // 阳控:同一把尺子在 .ps1 上仍然走 powershell -File,证明它不是「什么都原样返回」。
  it('.ps1 仍然经 powershell -File 起', () => {
    const PS1 = 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.ps1';
    const resolved = resolveLocalPtySpawn({
      platform: 'win32',
      env: WIN_ENV,
      fileExists: (candidate) => candidate === PS1,
      intent: {
        kind: 'run-command',
        cwd: 'C:\\repo',
        command: { kind: 'argv', command: PS1, args: ['--version'] },
      },
    });
    expect(resolved.command).toBe('powershell.exe');
    expect(resolved.args).toEqual([
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, '--version',
    ]);
  });
});

describe('Windows .cmd shim resolves to its real executable', () => {
  const WIN_ENV = { ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: '', PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  // 真文件:`resolveWindowsHandoffExecutable` 读的是壳脚本本身,所以这条判据得有一个真的壳。
  let dir: string;
  let shim: string;
  let target: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gugu-pty-shim-'));
    shim = join(dir, 'claude.cmd');
    // 壳里写的是 Windows 分隔符,解析出来的目标也就是 Windows 分隔符 —— 判据照它拼,
    // ❌ 不要把整条路径的 `/` 全换成 `\`:临时目录那一段在 macOS 上本来就是 `/`。
    target = `${dir}\\node_modules\\bin\\claude.exe`;
    writeFileSync(
      shim,
      ['@ECHO off', 'SET dp0=%~dp0', '"%dp0%\\node_modules\\bin\\claude.exe"   %*', ''].join('\r\n')
    );
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * 为什么值得钉:`.cmd` 最终由 cmd.exe 执行,而 cmd.exe 的命令行上限是 8191;
   * 这条 argv 上坐着用户的首句话(≤16,384 字符才落盘),过壳只会得到一句
   * `The command line is too long.`。直接起壳里那个 `.exe` 走 CreateProcess 的 32767 上限。
   */
  it('起的是壳里那个 .exe,不是壳', () => {
    const resolved = resolveLocalPtySpawn({
      platform: 'win32',
      env: WIN_ENV,
      fileExists: (candidate) => candidate === shim || candidate === target,
      intent: {
        kind: 'run-command',
        cwd: 'C:\\repo',
        command: { kind: 'argv', command: shim, args: ['--model', 'sonnet'] },
      },
    });
    expect(resolved.command).toBe(target);
    expect(resolved.args).toEqual(['--model', 'sonnet']);
  });

  /**
   * 壳里跑的是 `node …cli.js`(npm 装的 codex、咕咕托管装的 npm 形态)⇒ 直接起 `node.exe <脚本> <原参数…>`,
   * 同样绕开 cmd.exe 的 8191。壳的正文逐字取自 npm cmd-shim 9.0.2 与 aube 2.2.17(见 windows-node-entry.test.ts)。
   */
  const winPath = (p: string) => p.replaceAll('/', '\\');
  const NPM_CMD_SHIM = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '', 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')', '', 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*', ''].join('\r\n');
  const run = (command: string, fileExists: (candidate: string) => boolean, env = WIN_ENV) =>
    resolveLocalPtySpawn({
      platform: 'win32',
      env,
      fileExists,
      intent: { kind: 'run-command', cwd: 'C:\\repo', command: { kind: 'argv', command, args: ['--version'] } },
    });

  it('壳里跑的是 node + 脚本:直接起壳旁边的 node.exe', () => {
    const jsShim = join(dir, 'codex.cmd');
    writeFileSync(jsShim, NPM_CMD_SHIM);
    const node = `${winPath(dir)}\\node.exe`;
    const entry = `${winPath(dir)}\\node_modules\\@openai\\codex\\bin\\codex.js`;
    const resolved = run(jsShim, (candidate) => candidate === jsShim || candidate === node || candidate === entry);
    expect(resolved.command).toBe(node);
    expect(resolved.args).toEqual([entry, '--version']);
    expect(resolved.env).toEqual({});
  });

  it('壳旁边没有 node.exe:照 cmd.exe 的找法在 PATH 上找 node', () => {
    const jsShim = join(dir, 'codex.cmd');
    writeFileSync(jsShim, NPM_CMD_SHIM);
    const entry = `${winPath(dir)}\\node_modules\\@openai\\codex\\bin\\codex.js`;
    const pathNode = 'C:\\node\\node.EXE';
    const resolved = run(
      jsShim,
      (candidate) => candidate === jsShim || candidate === entry || candidate === pathNode,
      { ...WIN_ENV, PATH: 'C:\\node' }
    );
    expect(resolved.command).toBe(pathNode);
    expect(resolved.args).toEqual([entry, '--version']);
  });

  it('aube 壳设的 NODE_PATH 随 spawn 带出去', () => {
    const aubeShim = join(dir, 'pi.cmd');
    writeFileSync(aubeShim, ['@SETLOCAL', '@SET NODE_PATH=%~dp0..;%~dp0..\\.mise\\node_modules', '@IF EXIST "%~dp0\\node.exe" (', '  "%~dp0\\node.exe" "%~dp0\\..\\.mise\\pi\\dist\\cli.js" %*', ') ELSE (', '  @SET PATHEXT=%PATHEXT:;.JS;=;%', '  node "%~dp0\\..\\.mise\\pi\\dist\\cli.js" %*', ')', ''].join('\r\n'));
    const parent = winPath(dirname(dir));
    const node = `${winPath(dir)}\\node.exe`;
    const entry = `${parent}\\.mise\\pi\\dist\\cli.js`;
    const resolved = run(aubeShim, (candidate) => candidate === aubeShim || candidate === node || candidate === entry);
    expect(resolved.command).toBe(node);
    expect(resolved.args).toEqual([entry, '--version']);
    expect(resolved.env).toEqual({ NODE_PATH: `${parent};${parent}\\.mise\\node_modules` });
  });

  // 阴控:认不全的壳(还 SET 了别的变量)⇒ 照旧起壳,❌ 跳过它。
  it('认不全的壳照旧起壳', () => {
    const jsShim = join(dir, 'odd.cmd');
    writeFileSync(jsShim, NPM_CMD_SHIM.replace('SETLOCAL\r\n', 'SETLOCAL\r\nSET NODE_OPTIONS=--inspect\r\n'));
    const resolved = run(jsShim, () => true);
    expect(resolved.command).toBe(jsShim);
    expect(resolved.args).toEqual(['--version']);
    expect(resolved.env).toBeUndefined();
  });
});
