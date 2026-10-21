import os from 'node:os';
import { TRANSPORT_ENV_VARS } from '@gugu/session-core/agents/agent-env';
import { agentShellEnvPassThrough } from '@gugu/session-plugins/agents';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import { buildUserShellBaseEnv } from '@main/utils/childProcessEnv';
import { detectSshAuthSock } from '@main/utils/shellEnv';
import { systemProxyFill } from '@main/utils/systemProxyEnv';
import { loginShellEnv } from '@main/utils/userEnv';
import { getWindowsEnvValue } from '@main/utils/windows-env';
import { guguNodeEnv } from './gugu-node';
import { cliIntegrationPathEnv } from '../integrations/cli/cli-paths';
import { serverBrowserEnv } from './server-browser-env';

const DISPLAY_ENV_VARS = [
  'DISPLAY', // X11 display server
  'XAUTHORITY', // X11 auth cookie (often non-standard path on Wayland+GNOME)
  'WAYLAND_DISPLAY', // Wayland compositor socket
  'XDG_RUNTIME_DIR', // Contains Wayland/D-Bus sockets (e.g. /run/user/1000)
  'XDG_CURRENT_DESKTOP', // Used by xdg-open for DE detection
  'XDG_SESSION_TYPE', // Used by browsers/toolkits to select X11 vs Wayland
  'DBUS_SESSION_BUS_ADDRESS', // Needed by gio open and desktop portals
] as const;

const GLOBAL_AGENT_ENV_VARS = ['EDITOR', 'VISUAL', 'GIT_EDITOR', 'HOSTNAME', 'LANG', 'TZ'] as const;

function getAllowlistedEnv(keys: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of keys) {
    const val = process.env[key];
    if (val) env[key] = val;
  }
  return env;
}

function getWindowsEssentialEnv(resolvedPath: string): Record<string, string> {
  const home = os.homedir();
  return {
    PATH: resolvedPath,
    PATHEXT:
      getWindowsEnvValue(process.env, 'PATHEXT') ||
      '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC',
    SystemRoot: getWindowsEnvValue(process.env, 'SystemRoot') || 'C:\\Windows',
    ComSpec: getWindowsEnvValue(process.env, 'ComSpec') || 'C:\\Windows\\System32\\cmd.exe',
    TEMP: getWindowsEnvValue(process.env, 'TEMP') || getWindowsEnvValue(process.env, 'TMP') || '',
    TMP: getWindowsEnvValue(process.env, 'TMP') || getWindowsEnvValue(process.env, 'TEMP') || '',
    USERPROFILE: getWindowsEnvValue(process.env, 'USERPROFILE') || home,
    APPDATA: getWindowsEnvValue(process.env, 'APPDATA') || '',
    LOCALAPPDATA: getWindowsEnvValue(process.env, 'LOCALAPPDATA') || '',
    HOMEDRIVE: getWindowsEnvValue(process.env, 'HOMEDRIVE') || '',
    HOMEPATH: getWindowsEnvValue(process.env, 'HOMEPATH') || '',
    USERNAME: getWindowsEnvValue(process.env, 'USERNAME') || os.userInfo().username,
    ProgramFiles: getWindowsEnvValue(process.env, 'ProgramFiles') || 'C:\\Program Files',
    'ProgramFiles(x86)':
      getWindowsEnvValue(process.env, 'ProgramFiles(x86)') || 'C:\\Program Files (x86)',
    ProgramData: getWindowsEnvValue(process.env, 'ProgramData') || 'C:\\ProgramData',
    CommonProgramFiles:
      getWindowsEnvValue(process.env, 'CommonProgramFiles') || 'C:\\Program Files\\Common Files',
    'CommonProgramFiles(x86)':
      getWindowsEnvValue(process.env, 'CommonProgramFiles(x86)') ||
      'C:\\Program Files (x86)\\Common Files',
    ProgramW6432: getWindowsEnvValue(process.env, 'ProgramW6432') || 'C:\\Program Files',
    CommonProgramW6432:
      getWindowsEnvValue(process.env, 'CommonProgramW6432') || 'C:\\Program Files\\Common Files',
  };
}

export interface AgentEnvOptions {
  /**
   * Pass through the agent shell-env allowlist (`agentShellEnvPassThrough`) from process.env.
   * Defaults to true — set false only for tests or sandboxed environments.
   */
  agentApiVars?: boolean;

  /**
   * Include SHELL in the env (needed for shell-wrapper spawns so the shell
   * can reconstruct login env via -il flags).
   */
  includeShellVar?: boolean;

  /**
   * Resolved shell used to launch the agent command. POSIX login shells can
   * synthesize SHELL from the user's account default, so pass the configured
   * shell explicitly when the command is shell-wrapped.
   */
  shellProfile?: ResolvedShellProfile;

  /**
   * Gugu hook server connection details.  When set, injects
   * GUGU_HOOK_PORT, GUGU_PTY_ID, and GUGU_HOOK_TOKEN so agent CLIs
   * can call back on lifecycle events.
   */
  hook?: {
    port: number;
    ptyId: string;
    token: string;
  };

  /**
   * Per-provider variables configured in custom execution settings.
   */
  providerVars?: Record<string, string>;

  /**
   * 是否铺「用户登录环境」这一层底座（#5873）。默认 **true** —— 本机的每一条腿都要它。
   *
   * ❌ 只有一处该关掉：把 env 当前缀发到**远端**机器的那条腿
   * （`LegacySshAcpProcessHost`）。本机登录 shell 里那一整份环境搬到别人机器上，既是把本机
   * 配置外泄，也会盖掉远端自己采到的 profile（`captureRemoteShellProfile` 采的是**那台**机器的
   * 整份 env）。远端那一票 key / 代理由白名单层照旧跟过去，语义不变。
   */
  includeUserShellEnv?: boolean;
}

/**
 * Build an environment for a user-facing interactive terminal session.
 *
 * Unlike buildAgentEnv, this inherits process.env wholesale so the terminal
 * feels identical to one opened in Ghostty or Terminal.app — the user's
 * EDITOR, MANPATH, JAVA_HOME, custom vars, etc. are all present.
 *
 * TERM, COLORTERM, and TERM_PROGRAM are always set or overridden so programs
 * inside the terminal report the correct terminal identity. SHELL is only
 * synthesized on POSIX platforms.
 * SSH_AUTH_SOCK is injected via the same cached detector used for agents,
 * since GUI-launched apps often don't inherit it from the user's login shell.
 */
export function buildTerminalEnv(
  options: { shellProfile?: ResolvedShellProfile } = {}
): Record<string, string> {
  // Inherit the full process environment, stripping undefined values.
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined) env[key] = val;
  }

  // Terminal identity — always override so xterm capabilities are correct.
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'gugu';

  // Ensure SHELL reflects the user's configured shell on POSIX. Native Windows
  // shells are selected via ComSpec by the spawn resolver, not SHELL.
  if (process.platform !== 'win32') {
    env.SHELL =
      options.shellProfile?.family === 'posix' || options.shellProfile?.family === 'csh'
        ? options.shellProfile.executable
        : (process.env.SHELL ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'));
  } else if (process.env.SHELL) {
    env.SHELL = process.env.SHELL;
  }

  // detectSshAuthSock() is the real source here, not an edge-case fallback: the host's startup
  // hydration (electron/shellPath.ts) merges only PATH into process.env — the rest of the
  // login-shell env stays out of the GUI process and is applied on the spawn side instead —
  // so SSH_AUTH_SOCK normally arrives via the launchctl / socket-location scan.
  // 这条腿走的是登录 shell(`-il`),rc 里的东西由那个 shell 自己 source,所以它**不**铺
  // `buildUserShellBaseEnv` 的底座 —— 那是给不经 shell 的那两条腿补的(#5873)。
  if (!env.SSH_AUTH_SOCK) {
    const sshAuthSock = detectSshAuthSock();
    if (sshAuthSock) env.SSH_AUTH_SOCK = sshAuthSock;
  }

  // #6264 咕咕 server 上起的终端:与 agent 同一组「打开网页转到人那一侧」(server-browser-env.ts)。
  Object.assign(env, serverBrowserEnv(env.PATH));

  return env;
}

/**
 * Build the environment for an agent spawn — TUI 腿、聊天(ACP)腿、模型探针共用这一份。
 *
 * 分两层，低 → 高：
 *
 * 1. **用户环境底座**（`buildUserShellBaseEnv`，#5873）：登录 shell 的整份环境快照 + 本进程
 *    继承到的环境，一起过一张**负名单**。用户按常规 export 在 `~/.zshrc` 里的东西
 *    （三方中转的 `S2T_API_KEY` 这种**自定义**名字、`HTTP_PROXY`）只能从这里来 —— 白名单
 *    按定义认不出它没见过的名字。
 * 2. **咕咕算好的那几格**：终端身份、PATH（启动时已并过登录 PATH 且托管目录排在最前）、
 *    HOME/USER、平台补偿，加上 `agentShellEnvPassThrough()` / `TRANSPORT_ENV_VARS` 白名单从
 *    `process.env` 的透传。它们描述的是「咕咕起的这条会话」，所以一律压过底座。
 *
 * 负名单挡掉的是三类：交互式终端的身份/几何（那是用户自己的终端，不是这条 stdio 会话）、
 * 咕咕自己的控制通道（`GUGU_*` / 工作区信任 / Electron 进程形态）、以及由上层算的 PATH。
 * 清单与理由见 `buildUserShellBaseEnv`。
 */
export function buildAgentEnv(options: AgentEnvOptions = {}): Record<string, string> {
  const {
    agentApiVars = true,
    includeShellVar = false,
    includeUserShellEnv = true,
    hook,
    providerVars,
    shellProfile,
  } = options;

  // process.env.PATH is enriched at startup by the host's hydrateLoginShellPath()
  // (electron/shellPath.ts) so it already contains the full login-shell PATH
  // (Homebrew, nvm, npm globals, etc.).
  const resolvedPath =
    process.platform === 'win32'
      ? (getWindowsEnvValue(process.env, 'PATH') ?? '')
      : (process.env.PATH ?? '');
  const env: Record<string, string> = {
    // 底座:用户登录环境。上面每一格都压得过它 —— 尤其 PATH,那一格已经把登录 PATH 并过一次,
    // 且咕咕的托管安装目录排在最前(#4271「更新成功、版本不变」正是它被顶掉的后果)。
    ...(includeUserShellEnv ? buildUserShellBaseEnv({ loginShellEnv: loginShellEnv() }) : {}),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'gugu',
    HOME: process.env.HOME || os.homedir(),
    USER: process.env.USER || os.userInfo().username,
    PATH: resolvedPath,
    ...(process.env.TMPDIR && { TMPDIR: process.env.TMPDIR }),
    ...getAllowlistedEnv(GLOBAL_AGENT_ENV_VARS),
    ...getAllowlistedEnv(DISPLAY_ENV_VARS),
    ...(process.platform === 'win32' ? getWindowsEssentialEnv(resolvedPath) : {}),
  };

  const sshAuthSock = process.env.SSH_AUTH_SOCK ?? detectSshAuthSock();
  if (sshAuthSock) env.SSH_AUTH_SOCK = sshAuthSock;

  if (
    process.platform !== 'win32' &&
    (shellProfile?.family === 'posix' || shellProfile?.family === 'csh')
  ) {
    env.SHELL = shellProfile.executable;
  } else if (includeShellVar && process.platform !== 'win32') {
    env.SHELL = process.env.SHELL || '/bin/bash';
  } else if (includeShellVar && process.env.SHELL) {
    env.SHELL = process.env.SHELL;
  }

  if (agentApiVars) {
    for (const key of TRANSPORT_ENV_VARS) {
      const val = process.env[key];
      if (val) env[key] = val;
    }
    for (const key of agentShellEnvPassThrough()) {
      const val = process.env[key];
      if (val) env[key] = val;
    }
  }

  if (providerVars) {
    Object.assign(env, providerVars);
  }

  // #6892 只开系统代理的用户:代理补进 agent 这一类子进程(上面已经有任何代理变量就不动)。
  Object.assign(env, systemProxyFill(env));

  // 咕咕自带的 Node(`gugu-node`,gugu-node.ts):它的目录排在 PATH 最前,App skill 带的脚本跑在它上面。
  Object.assign(env, guguNodeEnv(env.PATH));

  // #7210 资源库里连上的官方命令行(钉钉 dws、企业微信 wecom-cli):agent 敲的就是在咕咕里登录的那一个。
  Object.assign(env, cliIntegrationPathEnv(env.PATH));

  // #6264 咕咕 server 上:程序要「打开网页」时转到人那一侧(server-browser-env.ts;桌面版上是空的)。
  Object.assign(env, serverBrowserEnv(env.PATH));

  Object.assign(env, buildAgentHookEnv(hook));

  return env;
}

/**
 * 钩子回调的三个变量 —— 每条会话**各不相同**,所以它不属于「这一家跑起来是什么样」
 * (`AgentRunContext`),而是起进程那一刻的宿主注入。见 `composeAgentSpawnEnv` 的 `hostInjections`。
 */
export function buildAgentHookEnv(hook: AgentEnvOptions['hook']): Record<string, string> {
  if (!hook || hook.port <= 0) return {};
  return {
    GUGU_HOOK_PORT: String(hook.port),
    GUGU_PTY_ID: hook.ptyId,
    GUGU_HOOK_TOKEN: hook.token,
  };
}
