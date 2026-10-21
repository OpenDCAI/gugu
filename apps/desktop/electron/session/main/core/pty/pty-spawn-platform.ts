import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import { log } from '@main/lib/logger';
import { quoteCshArg } from '@main/utils/shellEscape';
import {
  diskWindowsShimReader,
  resolveWindowsHandoffExecutable,
  resolveWindowsNodeScriptLaunch,
} from '@gugu/session-core/exec';
import { getWindowsEnvValue } from '@main/utils/windows-env';
import {
  buildTmuxShellLine,
  getConfiguredTmuxBinary,
  getConfiguredTmuxSocketLabel,
} from './tmux-session-name';

export type PtyCommandSpec =
  | { kind: 'argv'; command: string; args: string[] }
  | { kind: 'shell-line'; commandLine: string };

export type PtySpawnIntent =
  | {
      kind: 'interactive-shell';
      cwd: string;
      shellProfile?: ResolvedShellProfile;
      shellSetup?: string;
      tmuxEnabled?: boolean;
      tmuxSessionName?: string;
    }
  | {
      kind: 'run-command';
      cwd: string;
      command: PtyCommandSpec;
      shellProfile?: ResolvedShellProfile;
      shellSetup?: string;
      tmuxEnabled?: boolean;
      tmuxSessionName?: string;
    };

export type LocalPtySpawnWarning = 'shell_setup_ignored_on_windows' | 'tmux_unsupported_on_windows';

export type ResolvedLocalPtySpawn = {
  command: string;
  args: string[];
  cwd: string;
  warnings: LocalPtySpawnWarning[];
  /** 跳过的那层壳原本会给子进程设的变量;调用方叠在 spawn env 的最上面(壳里的 SET 本来就最后执行)。 */
  env?: Record<string, string>;
};

type FileExists = (candidate: string) => boolean;

function getPosixShell(env: NodeJS.ProcessEnv): string {
  return env.SHELL || '/bin/sh';
}

function getWindowsShell(env: NodeJS.ProcessEnv): string {
  return env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
}

function getResolvedShell(intent: PtySpawnIntent, env: NodeJS.ProcessEnv): string {
  return intent.shellProfile?.executable ?? getPosixShell(env);
}

function getInteractiveArgs(intent: PtySpawnIntent): string[] {
  return intent.shellProfile?.interactiveArgs ?? ['-il'];
}

function getCommandArgs(intent: PtySpawnIntent): string[] {
  return intent.shellProfile?.commandArgs ?? ['-c'];
}

function getSetupWrapperArgs(intent: PtySpawnIntent): string[] {
  if (!intent.shellProfile) return ['-c'];
  switch (intent.shellProfile.family) {
    case 'posix':
    case 'csh':
      return ['-c'];
    case 'windows-cmd':
    case 'powershell':
    case 'wsl':
      return intent.shellProfile.commandArgs;
  }
}

function shellArgQuoter(intent: PtySpawnIntent): (input: string) => string {
  return intent.shellProfile?.family === 'csh' ? quoteCshArg : quotePosixArg;
}

function isWindows(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

function quotePosixArg(input: string): string {
  if (input.length === 0) return "''";
  if (!/[\s'"\\$`\n\r\t;&|<>(){}[\]*?!]/.test(input)) return input;
  return `'${input.replace(/'/g, "'\\''")}'`;
}

function argvToPosixShellLine(intent: PtySpawnIntent, command: string, args: string[]): string {
  return [command, ...args].map(shellArgQuoter(intent)).join(' ');
}

function quoteForCmdExe(input: string): string {
  if (input.length === 0) return '""';
  if (!/[\s"^&|<>()%!]/.test(input)) return input;
  return `"${input
    .replace(/%/g, '%%')
    .replace(/!/g, '^!')
    .replace(/(["^&|<>()])/g, '^$1')}"`;
}

function quoteForPowerShell(input: string): string {
  if (input.length === 0) return "''";
  if (!/[\s'`"$;&|<>(){}[\],]/.test(input)) return input;
  return `'${input.replace(/'/g, "''")}'`;
}

/**
 * cmd.exe + /S /C has a quirk: if the command string starts with a quote, the
 * outer quotes are taken as part of the executable name (printed back as
 * `'"C:\Program Files\..."' is not recognized`). The documented workaround is
 * to wrap the entire command line in an extra pair of outer quotes so cmd.exe
 * strips one layer and runs the still-quoted path.
 */
function wrapCmdExeCommandLine(commandLine: string): string {
  return commandLine.startsWith('"') ? `"${commandLine}"` : commandLine;
}

function getWindowsPathDirs(env: NodeJS.ProcessEnv): string[] {
  const rawPath = getWindowsEnvValue(env, 'PATH') ?? '';
  return rawPath.split(path.win32.delimiter).filter(Boolean);
}

function getWindowsPathExts(
  env: NodeJS.ProcessEnv,
  options: { powershell?: boolean } = {}
): string[] {
  const rawPathExt =
    getWindowsEnvValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';
  const exts = rawPathExt
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));
  if (!options.powershell) return exts;

  const normalized = new Set(exts.map((ext) => ext.toUpperCase()));
  if (!normalized.has('.PS1')) exts.push('.PS1');

  const priority = new Map([
    ['.COM', 0],
    ['.EXE', 1],
    ['.PS1', 2],
    ['.CMD', 3],
    ['.BAT', 4],
  ]);
  return [...exts].sort((a, b) => {
    const aRank = priority.get(a.toUpperCase()) ?? 5;
    const bRank = priority.get(b.toUpperCase()) ?? 5;
    return aRank - bRank;
  });
}

function hasWindowsPathSeparator(command: string): boolean {
  return command.includes('\\') || command.includes('/');
}

function resolveWindowsCommandPath({
  command,
  cwd,
  env,
  fileExists,
  powershell = false,
}: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  fileExists: FileExists;
  powershell?: boolean;
}): string | null {
  if (path.win32.extname(command)) {
    return null;
  }

  const baseCandidates =
    hasWindowsPathSeparator(command) || path.win32.isAbsolute(command)
      ? [path.win32.isAbsolute(command) ? command : path.win32.join(cwd, command)]
      : [
          path.win32.join(cwd, command),
          ...getWindowsPathDirs(env).map((dir) => path.win32.join(dir, command)),
        ];

  for (const base of baseCandidates) {
    for (const ext of getWindowsPathExts(env, { powershell })) {
      const candidate = `${base}${ext}`;
      if (fileExists(candidate)) return candidate;
    }
  }

  return null;
}

function windowsWarnings(intent: PtySpawnIntent): LocalPtySpawnWarning[] {
  const warnings: LocalPtySpawnWarning[] = [];
  if (intent.shellSetup) warnings.push('shell_setup_ignored_on_windows');
  if (intent.tmuxSessionName) warnings.push('tmux_unsupported_on_windows');
  return warnings;
}

function windowsShellLineSpawn({
  commandLine,
  cwd,
  env,
  shellProfile,
  warnings,
}: {
  commandLine: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  shellProfile: PtySpawnIntent['shellProfile'];
  warnings: LocalPtySpawnWarning[];
}): ResolvedLocalPtySpawn {
  const shell = shellProfile?.executable ?? getWindowsShell(env);
  const commandArgs = shellProfile?.commandArgs ?? ['/d', '/s', '/c'];
  const usesCmdSyntax = shellProfile?.family !== 'powershell' && shellProfile?.family !== 'wsl';
  const commandLineArg = usesCmdSyntax ? wrapCmdExeCommandLine(commandLine) : commandLine;
  return {
    command: shell,
    args: [...commandArgs, commandLineArg],
    cwd,
    warnings,
  };
}

function cmdShellLineSpawn({
  commandLine,
  cwd,
  env,
  warnings,
}: {
  commandLine: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  warnings: LocalPtySpawnWarning[];
}): ResolvedLocalPtySpawn {
  return {
    command: getWindowsShell(env),
    args: ['/d', '/s', '/c', wrapCmdExeCommandLine(commandLine)],
    cwd,
    warnings,
  };
}

function powerShellFileArgs(suppressProfile: boolean): string[] {
  return [suppressProfile ? '-NoProfile' : '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File'];
}

function resolveWindowsSpawn(
  intent: PtySpawnIntent,
  env: NodeJS.ProcessEnv,
  fileExists: FileExists
): ResolvedLocalPtySpawn {
  const warnings = windowsWarnings(intent);
  const shell = intent.shellProfile?.executable ?? getWindowsShell(env);

  if (intent.kind === 'interactive-shell') {
    return {
      command: shell,
      args: intent.shellProfile?.interactiveArgs ?? [],
      cwd: intent.cwd,
      warnings,
    };
  }

  if (intent.command.kind === 'shell-line') {
    return windowsShellLineSpawn({
      commandLine: intent.command.commandLine,
      cwd: intent.cwd,
      env,
      shellProfile: intent.shellProfile,
      warnings,
    });
  }

  const { command, args } = intent.command;
  if (intent.shellProfile?.family === 'wsl') {
    return windowsShellLineSpawn({
      commandLine: argvToPosixShellLine(intent, command, args),
      cwd: intent.cwd,
      env,
      shellProfile: intent.shellProfile,
      warnings,
    });
  }

  const resolvedCommand =
    resolveWindowsCommandPath({
      command,
      cwd: intent.cwd,
      env,
      fileExists,
      powershell: intent.shellProfile?.family === 'powershell',
    }) ?? command;
  const ext = path.win32.extname(resolvedCommand).toLowerCase();

  if (ext === '.cmd' || ext === '.bat') {
    // 直接起这个壳,**不经过任何 shell** —— 既不拼 `cmd.exe /d /s /c "<命令行>"`,
    // 也不走 `pwsh -Command "& <行>"`(用户把默认终端设成 PowerShell 时走的就是后者)。
    //
    // 经过 shell 的那两版都会把**带双引号的参数**送坏,而咕咕自己就在发这样的参数
    // (codex 那条腿的 `-c features.code_mode.direct_only_tool_namespaces=["gugu"]`)。
    // 2026-09-18 Windows 真机、用一个回显自己 argv 的 `.cmd` 当仪器量到:
    //
    //   want   ["-c","features.code_mode.direct_only_tool_namespaces=[\"gugu\"]", …]
    //   pwsh   ["-c","features.code_mode.direct_only_tool_namespaces=[gugu]",     …]  ← 引号被 PowerShell 吃掉
    //   cmd    ["-c","features.code_mode.direct_only_tool_namespaces=[^gugu]",    …]  ← 引号没了、脱字符留下
    //   直接起 ["-c","features.code_mode.direct_only_tool_namespaces=[\"gugu\"]", …]  ← 逐字节正确
    //
    // codex 于是拒绝加载配置(`data did not match any variant of untagged enum FeatureToml
    // in features.code_mode`),整条 Code/TUI 会话当场死。
    //
    // ⇒ 对一条 **argv** 形态的 run-command,shell 在这里**什么也没做**:Windows 上
    //   `shellSetup` 本来就被忽略(见 windowsWarnings)、tmux 不支持,而 `.exe` 那一支
    //   从来就是直接起的。留着它只是多一层各自不同的引号规矩,而两层都是错的。
    //   ❌ 不要「换一种拼法」:两条 spawn 机制(node-pty / ProcessStartInfo)各自都会按
    //   Windows 的规矩把 argv 编码一次,交给它们做就对了。
    // 壳只是去跑一个真可执行文件时,**直接跑那一个**。
    //
    // 理由是一条硬上限:`.cmd` 无论谁来起,最终都由 cmd.exe 执行,而 cmd.exe 的命令行上限是
    // **8191** 字符。这条 argv 上坐着用户的首句话(≤16,384 字符才落盘,见 spill-large-prompt)
    // ⇒ 过壳会炸,而 cmd.exe 只回一句 `The command line is too long.` —— 终端里就这么一行,
    // 看不出是谁太长。直接起壳里那个 `.exe` 走的是 CreateProcess 的 **32767** 上限。
    // (claude 的 13.5 KB 系统提示曾经也在这条 argv 上 —— 2026-09-18 真机实测整条 14052 字符;
    //  它现在走提示档、argv 上只有路径,见 claude/session-bundle.ts 的 `tuiPromptFile`。)
    //
    // 壳里跑的是 `node "<脚本>" %*`(npm / pnpm / aube 装的 JS 包,包括咕咕托管装的那些)时,直接起
    // `node.exe <脚本> <原参数…>`,同样走 32767:读壳的规矩与认不全就返回 null 的理由见 windows-node-entry.ts。
    // 两样都认不出来就照旧起壳:❌ 不猜一个。
    const handoff = resolveWindowsHandoffExecutable(resolvedCommand, { platform: 'win32', exists: fileExists });
    if (handoff) return { command: handoff, args, cwd: intent.cwd, warnings };
    const script = resolveWindowsNodeScriptLaunch(resolvedCommand, {
      platform: 'win32',
      reader: { readShim: diskWindowsShimReader.readShim, exists: fileExists },
    });
    // 壳选了 PATH 上的 `node`:照 cmd.exe 的找法(当前目录、PATH、PATHEXT)解析,只接受真可执行文件。
    const node = script && (path.win32.isAbsolute(script.node)
      ? script.node
      : resolveWindowsCommandPath({ command: script.node, cwd: intent.cwd, env, fileExists }));
    if (script && node && /\.(?:exe|com)$/i.test(node)) {
      return { command: node, args: [script.entry, ...args], cwd: intent.cwd, warnings, env: script.env };
    }
    return { command: resolvedCommand, args, cwd: intent.cwd, warnings };
  }

  if (ext === '.ps1') {
    const selectedPowerShell =
      intent.shellProfile?.family === 'powershell' ? intent.shellProfile : undefined;
    return {
      command: selectedPowerShell?.executable ?? 'powershell.exe',
      args: [...powerShellFileArgs(selectedPowerShell === undefined), resolvedCommand, ...args],
      cwd: intent.cwd,
      warnings,
    };
  }

  if (!ext) {
    if (intent.shellProfile?.family === 'powershell') {
      return windowsShellLineSpawn({
        commandLine: `& ${[command, ...args].map(quoteForPowerShell).join(' ')}`,
        cwd: intent.cwd,
        env,
        shellProfile: intent.shellProfile,
        warnings,
      });
    }
    // ⚠️ 无扩展名的路径 CreateProcess 起不来,只能包 cmd.exe,所以这一支仍在自己拼命令行 ——
    // 也就仍然带着上面 `.cmd` 那一支刚摘掉的那个毛病:**带双引号的参数会被送坏**。
    // 没有一起改,是因为两种拼法各坏一种(实测:拼好的坏引号、不拼的坏带空格的路径),
    // 而这一支的入口是「用户显式给了一条无扩展名的绝对路径」—— 咕咕自己解析出来的从来是
    // `.cmd` / `.exe`(PATHEXT)。要动它得先量到一个真实的失败现场,❌ 不凭猜换一种坏法。
    return cmdShellLineSpawn({
      commandLine: [command, ...args].map(quoteForCmdExe).join(' '),
      cwd: intent.cwd,
      env,
      warnings,
    });
  }

  return { command: resolvedCommand, args, cwd: intent.cwd, warnings };
}

function resolvePosixSpawn(intent: PtySpawnIntent, env: NodeJS.ProcessEnv): ResolvedLocalPtySpawn {
  if (intent.tmuxEnabled && !intent.tmuxSessionName) {
    log.warn('PTY spawn requested tmux but no session name was generated; spawning without tmux', {
      kind: intent.kind,
      cwd: intent.cwd,
      effectiveTmuxEnabled: true,
      tmuxSessionName: null,
      reason: 'tmuxSessionName missing from spawn intent',
    });
  }
  const shell = getResolvedShell(intent, env);
  const interactiveArgs = getInteractiveArgs(intent);
  const commandArgs = getCommandArgs(intent);
  const setupWrapperArgs = getSetupWrapperArgs(intent);

  if (intent.kind === 'interactive-shell') {
    if (intent.tmuxSessionName) {
      const commandLine = intent.shellSetup
        ? `${intent.shellSetup} && exec ${quotePosixArg(shell)} ${interactiveArgs.join(' ')}`
        : `exec ${quotePosixArg(shell)} ${interactiveArgs.join(' ')}`;
      return {
        command: shell,
        args: [
          ...(intent.shellSetup ? setupWrapperArgs : commandArgs),
          buildTmuxShellLine(intent.tmuxSessionName, commandLine, {
            binary: getConfiguredTmuxBinary(),
            socketLabel: getConfiguredTmuxSocketLabel(),
          }),
        ],
        cwd: intent.cwd,
        warnings: [],
      };
    }

    if (intent.shellSetup) {
      return {
        command: shell,
        args: [
          ...setupWrapperArgs,
          `${intent.shellSetup} && exec ${quotePosixArg(shell)} ${interactiveArgs.join(' ')}`,
        ],
        cwd: intent.cwd,
        warnings: [],
      };
    }

    return { command: shell, args: interactiveArgs, cwd: intent.cwd, warnings: [] };
  }

  if (
    intent.shellProfile?.family === 'powershell' ||
    intent.shellProfile?.family === 'windows-cmd' ||
    intent.shellProfile?.family === 'wsl'
  ) {
    throw new Error(
      `Cannot run POSIX shell-wrapped commands through ${intent.shellProfile.resolvedShellId}`
    );
  }

  const commandLine =
    intent.command.kind === 'shell-line'
      ? intent.command.commandLine
      : argvToPosixShellLine(intent, intent.command.command, intent.command.args);
  const fullCommandLine = intent.shellSetup
    ? `${intent.shellSetup} && ${commandLine}`
    : commandLine;

  if (intent.tmuxSessionName) {
    return {
      command: shell,
      args: [
        ...commandArgs,
        buildTmuxShellLine(intent.tmuxSessionName, fullCommandLine, {
          binary: getConfiguredTmuxBinary(),
          socketLabel: getConfiguredTmuxSocketLabel(),
        }),
      ],
      cwd: intent.cwd,
      warnings: [],
    };
  }

  return {
    command: shell,
    args: [...commandArgs, fullCommandLine],
    cwd: intent.cwd,
    warnings: [],
  };
}

export function resolveLocalPtySpawn({
  intent,
  platform,
  env,
  fileExists = existsSync,
}: {
  intent: PtySpawnIntent;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fileExists?: FileExists;
}): ResolvedLocalPtySpawn {
  return isWindows(platform)
    ? resolveWindowsSpawn(intent, env, fileExists)
    : resolvePosixSpawn(intent, env);
}

export function logLocalPtySpawnWarnings(
  source: string,
  warnings: LocalPtySpawnWarning[],
  context: Record<string, string>
): void {
  if (warnings.length === 0) return;
  log.warn(`${source}: local PTY platform warning`, { ...context, warnings });
}
