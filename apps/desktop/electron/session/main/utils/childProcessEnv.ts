import { agentShellEnvDenied } from '@gugu/session-plugins/agents';
// 相对路径而非 `@main` 别名:本模块**宿主与会话页两个 bundle 都要用**,而宿主那侧是相对
// import 进来的(`electron/shellPath.ts` → `./session/main/utils/childProcessEnv`),那边解析不了
// 会话页的别名。`@gugu/session-*` 两侧都解析得了(main.ts 自己就在用),所以上面那条可以走别名。
import { isValidEnvVarName } from './shellEscape';

/**
 * Env overrides for any shell we spawn purely to *capture* the user's environment.
 *
 * A capture shell is started with `-lic`, so it sources the user's rc files. Those rc files
 * routinely do things that are fine for a human terminal and wrong for a 5-second probe:
 * oh-my-zsh checks for updates, the tmux plugin re-attaches a session. Both stall the probe
 * until it times out. Setting these makes the rc files skip that work.
 *
 * Lives here rather than next to a single caller because both the local login-shell probe
 * (electron/shellPath.ts) and the remote SSH capture (core/ssh/.../remote-shell-profile.ts)
 * need the identical set — one definition, no drift.
 */
export const SHELL_ENV_CAPTURE_GUARD: Record<string, string> = {
  DISABLE_AUTO_UPDATE: 'true',
  ZSH_TMUX_AUTOSTART: 'false',
  ZSH_TMUX_AUTOSTARTED: 'true',
};

const APPIMAGE_ENV_KEYS = [
  'APPDIR',
  'APPIMAGE',
  'ARGV0',
  'CHROME_DESKTOP',
  'GSETTINGS_SCHEMA_DIR',
  'OWD',
] as const;

const APPIMAGE_PATH_LIKE_ENV_KEYS = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS'] as const;

function stripPathLikeAppImageEntries(value: string, appDir?: string): string {
  const separator = process.platform === 'win32' ? ';' : ':';
  const parts = value.split(separator).filter(Boolean);
  if (parts.length === 0) return value;

  const filtered = parts.filter((part) => {
    if (appDir && part.startsWith(appDir)) return false;
    if (part.includes('/tmp/.mount_')) return false;
    return true;
  });

  return filtered.join(separator);
}

export function buildExternalToolEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const appDir = typeof baseEnv.APPDIR === 'string' ? baseEnv.APPDIR : undefined;

  for (const key of APPIMAGE_ENV_KEYS) {
    delete env[key];
  }

  for (const key of APPIMAGE_PATH_LIKE_ENV_KEYS) {
    const value = env[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    const cleaned = stripPathLikeAppImageEntries(value, appDir);
    if (cleaned.length > 0) env[key] = cleaned;
    else delete env[key];
  }

  for (const key of ['PYTHONHOME', 'PYTHONPATH'] as const) {
    const value = env[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    if ((appDir && value.startsWith(appDir)) || value.includes('/tmp/.mount_')) {
      delete env[key];
    }
  }

  return env;
}

/**
 * 一次性 / 位置相关的变量:它们描述的是**采样那一刻那个 shell**,搬到另一个进程里只会说谎。
 *
 * 与远端(SSH)采样共用一份定义 —— `core/ssh/lifecycle/remote-shell-profile.ts` 从这里取。
 * 两份独立实现正是 #2802 要消灭的东西。
 */
export const VOLATILE_ENV_KEYS: ReadonlySet<string> = new Set([
  '_',
  'PWD',
  'OLDPWD',
  'SHLVL',
  'COLUMNS',
  'LINES',
  // 「是谁、从哪台机器、经哪个 tty 打开了这个 shell」。GUI 从 ssh 会话里被拉起来时它们就在
  // `process.env` 里,而它们描述的是那条 ssh 连接,不是这条 agent 会话 —— 传下去只会让
  // 会话里的工具以为自己远端登录着。❌ 不含 `SSH_AUTH_SOCK`:那一格是真要用的(#5873)。
  'SSH_CLIENT',
  'SSH_CONNECTION',
  'SSH_TTY',
]);

/**
 * 交互式终端才有意义的身份/几何/复用器变量。
 *
 * 用户的登录 shell 是在**他的终端里**被采样的(或按终端的习惯配置的),所以这些值描述的是
 * iTerm / kitty / tmux,而不是咕咕起的这条 stdio 会话。灌下去的后果不是「多几个变量」:
 * 一个照着 `TMUX` 判断自己在复用器里的 CLI 会去发 passthrough 序列,而那头根本没有 tmux。
 */
const TERMINAL_SESSION_ENV_KEYS = [
  'TERM',
  'TERMCAP',
  'TERMINFO',
  'COLORTERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
  'WINDOWID',
  'LC_TERMINAL',
  'LC_TERMINAL_VERSION',
  'ITERM_PROFILE',
  'ITERM_SESSION_ID',
  'KITTY_WINDOW_ID',
  'KITTY_PID',
  'KITTY_LISTEN_ON',
  'KITTY_INSTALLATION_DIR',
  'WEZTERM_PANE',
  'WEZTERM_UNIX_SOCKET',
  'WEZTERM_EXECUTABLE',
  'WEZTERM_EXECUTABLE_DIR',
  'WEZTERM_CONFIG_FILE',
  'ALACRITTY_WINDOW_ID',
  'ALACRITTY_SOCKET',
  'ALACRITTY_LOG',
  'GHOSTTY_RESOURCES_DIR',
  'GHOSTTY_BIN_DIR',
  'VTE_VERSION',
  'TMUX',
  'TMUX_PANE',
  'ZELLIJ',
  'ZELLIJ_SESSION_NAME',
  'ZELLIJ_PANE_ID',
  'STY',
  'WINDOW',
] as const;

/**
 * 上层按平台算好的那几格。这一层是**底座**,❌ 不许插嘴。
 *
 * `PATH` 是其中唯一一个「灌错就全盘皆坏」的:咕咕自己的托管安装目录必须排在最前
 * (`ensureUserBinDirsInPath`),被用户 rc 里那份原样 PATH 顶掉就是 #4271 那一幕
 * ——「更新成功、版本不变」。登录 shell 的 PATH 早在启动时就已经并进 `process.env.PATH`
 * 了(`hydrateLoginShellPath`),所以这里丢掉它不丢任何信息。
 */
const HOST_COMPUTED_ENV_KEYS = ['PATH', 'SHELL'] as const;

/**
 * 咕咕自己的控制通道 + 进程形态。用户 shell 里一个同名 export 就能顶掉面板上的选择,
 * 而且不报错 —— 面板写着 A、跑起来是 B。判据与各家 `shellEnv.denied` 同源:
 *
 *   · `GUGU_*`  —— 钩子端口/令牌、选中的那份二进制、运行时 node、数据根;
 *   · `ELECTRON_*` —— 进程形态。`ELECTRON_RUN_AS_NODE` 漏下去会把子进程里那些以 electron
 *     二进制起的工具直接变成 node。
 *
 * 逐名拒绝的那批(工作区信任、各家的凭据 / 配置根 / TLS 开关)由 `agentShellEnvDenied` 给:
 * 与哪一家都无关的几个 + 各家插件 `shellEnv.denied` 的并集,与白名单出自同一处声明。
 * 需要显式透传的几个(测试夹具的 `GUGU_SESSION_TEST_HOOKS` 等)走白名单层,它排在这一层**之上**。
 */
const HOST_OWNED_ENV_PREFIXES = ['GUGU_', 'ELECTRON_'] as const;

const USER_SHELL_ENV_DENYLIST: ReadonlySet<string> = new Set<string>([
  ...VOLATILE_ENV_KEYS,
  ...TERMINAL_SESSION_ENV_KEYS,
  ...HOST_COMPUTED_ENV_KEYS,
  // 白名单时代「不在清单里就到不了会话」的那批显式拒绝。底座默认全过 ⇒ 不写下来就是从后门放进来。
  ...agentShellEnvDenied(),
]);

/** Windows 的环境变量名大小写不敏感(`Path` 与 `PATH` 是同一个),所以判据一律按大写比。 */
function isDeniedUserShellEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (USER_SHELL_ENV_DENYLIST.has(upper)) return true;
  return HOST_OWNED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * 「用户环境」这一层 —— 会话 env 的**底座**(#5873)。
 *
 * ## 它补的是什么洞
 *
 * 用户按常规把 key / 代理 export 在 `~/.zshrc` 里,而咕咕起的三条腿各自看不见它:
 *
 *   · 终端会话 `zsh -il`      —— ✅ 自己 source 了 rc;
 *   · 代码 / TUI 会话 `zsh -c` —— ❌ 非交互非登录,只读 `.zshenv`;
 *   · 聊天(ACP)会话          —— ❌ 裸 spawn 引擎进程,任何 rc 都不经过。
 *
 * 启动时的 `hydrateLoginShellPath()` 只取回了 PATH(源码注释原话:"imports PATH only"),
 * 所以 TUI 会话找得到二进制、却拿不到 key;`SSH_AUTH_SOCK` 另有一处特判。两处局部补丁
 * 说明这不是没人想过,而是只保了两个变量 —— 而缺口在 spawn 层,沿进程树向下传染:
 * 会话内 agent 跑 bash 工具、harness 拉 MCP server,继承的都是同一份残缺环境。
 *
 * 远端(SSH)那条腿从来没有这个问题:`captureRemoteShellProfile` 采的是**整份** env。
 * 这一层就是把本机补齐到同一条线上。
 *
 * ## 为什么是负名单
 *
 * 白名单按定义只认「咕咕见过的变量名」,而这一票用户配的正是**自定义**名字
 * (codex 的 `env_key = "S2T_API_KEY"` 是三方中转的标准配法)。要覆盖它只能反过来:
 * 默认全过,只挡掉几类确实不该过的。
 *
 * ## 为什么不写回 `process.env`
 *
 * 合并只发生在 spawn 侧。写回主进程会污染 GUI 自己的环境 —— AppImage 的
 * `LD_LIBRARY_PATH` 一类教训见 #2895,以及 `hydrateLoginShellPath` 抬头那一段。
 *
 * @param loginShellEnv 登录 shell 的环境快照(`loginShellEnvSnapshot()`);Windows / 采样失败时为 null。
 */
export function buildUserShellBaseEnv({
  loginShellEnv,
  processEnv = process.env,
}: {
  loginShellEnv?: Record<string, string> | null;
  processEnv?: NodeJS.ProcessEnv;
} = {}): Record<string, string> {
  // 两个来源,`process.env` 在上 —— 它是**本次启动**的环境,比 rc 里那份更明确:
  //  · 登录 shell 快照 —— 用户 rc 里的那一份。GUI 双击起的进程只有这条路拿得到它。
  //    **macOS 与 Linux 同一条路,没有平台分支**:`hydrateLoginShellPath` 只在 Windows 上返回,
  //    其余一律 `$SHELL -lic` 采样(mac 默认 zsh、Linux 默认 bash)。Linux 上这条缺口只多不少 ——
  //    桌面项 / AppImage 双击起来的进程连 `/etc/profile` 都没过。2026-09-19 在 Ubuntu 24.04 上
  //    用源码那段采样脚本逐字验过:`.profile → .bashrc` 里的自定义 key 采得回来,含换行的值不截断。
  //  · `process.env` —— 从终端里起咕咕时(`FOO=bar 咕咕`、无头 web 宿主)用户环境就在这儿;
  //    Windows 上更是**唯一**来源:那边没有登录 shell 这回事,用户环境块由系统在登录时直接
  //    交给 GUI 进程(`setx` / 系统属性面板写的都在里面),所以那边零进程、快照恒为 null。
  //
  // 两份都过同一张负名单,所以 GUI 进程自己那些内部变量(launchd 的 XPC_SERVICE_NAME、
  // 咕咕自己写的 `GUGU_*`、Electron 的进程形态开关)不会因为这一层而漏给 agent。
  const source: Record<string, string | undefined> = { ...(loginShellEnv ?? {}), ...processEnv };

  // AppImage 擦洗与本体其余外部工具 spawn 点同一个函数:采样 shell 可能把挂载点原样吐回来。
  const scrubbed = buildExternalToolEnv(source);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(scrubbed)) {
    if (typeof value !== 'string') continue;
    if (!isValidEnvVarName(key)) continue;
    if (isDeniedUserShellEnvKey(key)) continue;
    env[key] = value;
  }
  return env;
}
