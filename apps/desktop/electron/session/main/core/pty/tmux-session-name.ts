import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IExecutionContext } from '@gugu/session-core/exec';
import { log } from '@main/lib/logger';
import { quoteShellArg } from '@main/utils/shellEscape';

export const TMUX_SESSION_PREFIX = 'gugu-';
const TMUX_HISTORY_LIMIT = 100_000;

export type TmuxShellOptions = {
  /** Absolute binary path for local spawns; remote commands should leave this unset. */
  binary?: string;
  /** Socket label used to isolate local app sessions from the user's default server. */
  socketLabel?: string;
};

/** tmux 自己管的、按终端算的变量:❌ 从客户端拷(`update-environment` 里不列它们)。 */
export const TMUX_OWN_ENV = ['TMUX', 'TMUX_PANE', 'TERM', 'COLUMNS', 'LINES', 'SHLVL', 'PWD', 'OLDPWD', '_'] as const;

/**
 * 新建会话之前,让这个 tmux 服务器按名字从**这次的客户端**拷环境(`update-environment`)。
 *
 * ⚠️ 为什么需要:tmux 在一个已经在跑的服务器里新建会话时,会话里的进程拿的是服务器的全局环境
 * (= 第一次把服务器起起来的那次 spawn 的环境),❌ 不是这次的。于是第二条会话的 agent 带着第一条会话的
 * GUGU_PTY_ID、账号进程重启前的 hook 端口与 MCP 授权,也没有后来才有的 BROWSER —— 状态回不来、
 * 咕咕插件连不上(#6264 走查机实测:第二条会话的 claude 里 GUGU_PTY_ID 是第一条会话的)。
 *
 * 名字在运行时从这个 shell 自己的环境里取(这次 spawn 的真实环境,值 ❌ 进命令行 —— 里面有 MCP 授权,
 * 命令行谁都看得见;名字不是秘密)。服务器还没起时这一句失败无妨:那时 new-session 起的服务器全局环境就是这次的。
 * 只在咕咕自己的服务器(有 socketLabel)上改这个选项,❌ 动用户自己的 tmux。
 */
export function tmuxTakeClientEnvironment(tmux: string): string {
  const own = TMUX_OWN_ENV.join('|');
  const names = `$(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' | grep -Ev '^(${own})$' | sort -u | tr '\\n' ' ')`;
  return `${tmux} set-option -g update-environment "${names}" 2>/dev/null; `;
}

export function getConfiguredTmuxBinary(): string {
  return process.env.GUGU_TMUX_BIN?.trim() || 'tmux';
}

export function getConfiguredTmuxSocketLabel(): string | undefined {
  const label = process.env.GUGU_TMUX_SOCKET_LABEL?.trim();
  return label || undefined;
}

function tmuxInvocation(
  ctx: Pick<IExecutionContext, 'supportsLocalSpawn'>
): { command: string; argsPrefix: string[] } {
  if (!ctx.supportsLocalSpawn) return { command: 'tmux', argsPrefix: [] };
  const socketLabel = getConfiguredTmuxSocketLabel();
  return {
    command: getConfiguredTmuxBinary(),
    argsPrefix: socketLabel ? ['-L', socketLabel] : [],
  };
}

export function tmuxExecArgs(
  ctx: Pick<IExecutionContext, 'supportsLocalSpawn'>,
  args: string[]
): { command: string; args: string[] } {
  const invocation = tmuxInvocation(ctx);
  return { command: invocation.command, args: [...invocation.argsPrefix, ...args] };
}

export async function assertTmuxAvailable(
  ctx: Pick<IExecutionContext, 'supportsLocalSpawn' | 'exec'>,
  context: string
): Promise<void> {
  const { command, args } = tmuxExecArgs(ctx, ['-V']);
  try {
    await ctx.exec(command, args);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const configured = ctx.supportsLocalSpawn ? getConfiguredTmuxBinary() : 'tmux';
    const message = `${context}: tmux is enabled but unavailable (${configured}): ${detail}`;
    log.error(message);
    throw new Error(message);
  }
}

export function buildTmuxShellLine(
  sessionName: string,
  commandLine: string,
  options: TmuxShellOptions = {}
): string {
  const binary = options.binary?.trim() || 'tmux';
  const quotedBinary = binary === 'tmux' ? binary : quoteShellArg(binary);
  const socket = options.socketLabel?.trim()
    ? ` -L ${quoteShellArg(options.socketLabel.trim())}`
    : '';
  const tmux = `${quotedBinary}${socket}`;
  // Both values are parsed by the inner `/bin/sh -c` as well as the outer shell. JSON's
  // double quotes would leave prompt content such as `$()` and backticks executable there;
  // single-quote each shell argument so it remains data through both parses.
  const quotedName = quoteShellArg(sessionName);
  const quotedCmd = quoteShellArg(commandLine);
  // `-u` forces tmux into UTF-8 mode regardless of the inherited locale. GUI-launched
  // apps (e.g. Electron on macOS) often have no LANG set, so without this tmux assumes a
  // non-UTF-8 locale and mangles multibyte glyphs like Nerd-font/box-drawing characters.
  const unavailableMessage = quoteShellArg(
    `gugu: tmux is enabled but unavailable (${binary}); install tmux or repair the bundled runtime`
  );
  const preflight =
    `if ! command -v ${quotedBinary} >/dev/null 2>&1; then printf '%s\\n' ${unavailableMessage} >&2; exit 127; fi`;
  const checkExists = `${tmux} has-session -t ${quotedName} 2>/dev/null`;
  const takeClientEnv = options.socketLabel?.trim() ? tmuxTakeClientEnvironment(tmux) : '';
  const newSession = `{ ${takeClientEnv}${tmux} -u new-session -d -s ${quotedName} ${quotedCmd}; }`;
  const enableMouse = `${tmux} set-option -t ${quotedName} mouse on 2>/dev/null || true`;
  const setHistoryLimit = `${tmux} set-option -t ${quotedName} history-limit ${TMUX_HISTORY_LIMIT} 2>/dev/null || true`;
  // OSC 52(程序把文字写进剪贴板,如 nvim 的 "+y):tmux 默认 `external` 只让 tmux 自己的复制模式往外写,
  // 里面程序发的 OSC 52 被吞掉。`on` = 让它穿过 tmux 到达咕咕的终端,再由终端写进这台电脑的剪贴板
  // (VS Code / Zed 终端直连时本来就是这样)。这是 server 级选项;咕咕的 tmux 永远跑在自己那条 `-L`
  // 套接字上(GUGU_TMUX_SOCKET_LABEL),❌ 碰不到用户自己的 tmux。
  const enableClipboard = `${tmux} set-option -s set-clipboard on 2>/dev/null || true`;
  // tmux 在这里只是让终端活过重启的底座,❌ 不该露面:它默认的绿色状态栏会叠在 harness 自己的界面底下
  // (d22 实测,#6264)。只关咕咕自己这个会话的状态栏,用户自己的 tmux 会话不受影响。
  const hideStatus = `${tmux} set-option -t ${quotedName} status off 2>/dev/null || true`;
  const configure = `(${enableMouse}) && (${setHistoryLimit}) && (${enableClipboard}) && (${hideStatus})`;
  const attach = `${tmux} -u attach-session -t ${quotedName}`;
  const script = `${preflight}; (${checkExists} || ${newSession}) && ${configure} && ${attach}`;
  // This string is parsed by the selected outer shell (zsh/bash) before `/bin/sh` sees it.
  // Single-quote the entire script so provider prompts and system envelopes remain data in the
  // selected outer shell. The inner argument quoting above protects the second shell parse.
  return `/bin/sh -c ${quoteShellArg(script)}`;
}

export function makeTmuxSessionName(ptySessionId: string): string {
  const encoded = Buffer.from(ptySessionId, 'utf8').toString('base64url');
  return `${TMUX_SESSION_PREFIX}${encoded}`;
}

/**
 * Inverse of {@link makeTmuxSessionName}. Returns the encoded PTY session id, or
 * `null` if the name is not a well-formed gugu tmux session name. The
 * round-trip guard rejects anything that does not re-encode to exactly the same
 * name, so unrelated sessions are never misread as ours.
 */
export function decodeTmuxSessionName(sessionName: string): string | null {
  if (!sessionName.startsWith(TMUX_SESSION_PREFIX)) return null;
  const encoded = sessionName.slice(TMUX_SESSION_PREFIX.length);
  if (!encoded) return null;
  try {
    const ptySessionId = Buffer.from(encoded, 'base64url').toString('utf8');
    if (makeTmuxSessionName(ptySessionId) !== sessionName) return null;
    return ptySessionId;
  } catch {
    return null;
  }
}

/** `tmux -L <label>` 在本机的服务器套接字(tmux 的默认位置 `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/<label>`);Windows(psmux)与远端不适用 = null。 */
function localTmuxSocketPath(ctx: Pick<IExecutionContext, 'supportsLocalSpawn'>): string | null {
  const label = ctx.supportsLocalSpawn ? getConfiguredTmuxSocketLabel() : undefined;
  if (!label || process.platform === 'win32' || typeof process.getuid !== 'function') return null;
  return join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, label);
}

/**
 * 咕咕的 tmux 服务器里此刻有哪些会话(tmux 会话名)。tmux 这一侧「活没活」只认这一个读数:
 * 接回还是新起、pty 退出后进程还在不在、宿主退出时票的去留,都问它。
 *
 * ⚠️「没有 server」是一个读数(一个会话都没有);「tmux 调用失败」不是 —— 它必须抛出,❌ 当成空集或「不在」:
 * 那会把一个仍在跑的引擎当成没了,接着按新起去做(重签平台票会先撤掉它手上那一份)。
 */
export async function listTmuxSessionNames(
  ctx: Pick<IExecutionContext, 'supportsLocalSpawn' | 'exec'>
): Promise<Set<string>> {
  // 本机咕咕的服务器套接字还不存在 = tmux 也只会答「error connecting … (No such file or directory)」(下面认作空集)。
  // 空闲时没有任何会话起过 tmux,idle-reclaim 每分钟一次都落在这里:❌ 为一个已知答案从主进程 fork 一次 tmux。
  const socket = localTmuxSocketPath(ctx);
  if (socket && !existsSync(socket)) return new Set();
  const { command, args } = tmuxExecArgs(ctx, ['list-sessions', '-F', '#{session_name}']);
  let stdout: string;
  try {
    stdout = (await ctx.exec(command, args)).stdout;
  } catch (error) {
    const detail = `${(error as { stderr?: unknown }).stderr ?? ''} ${error instanceof Error ? error.message : String(error)}`;
    // tmux 在服务器不存在时以非零退出并这样说;这是「一个会话都没有」,不是故障。
    if (/no server running|error connecting to .*\(No such file or directory\)/i.test(detail)) return new Set();
    throw new Error(`cannot list tmux sessions (${command}): ${detail.trim()}`);
  }
  return new Set(stdout.split('\n').map((line) => line.trim()).filter(Boolean));
}

export async function killTmuxSession(ctx: IExecutionContext, sessionName: string): Promise<void> {
  try {
    const { command, args } = tmuxExecArgs(ctx, ['kill-session', '-t', sessionName]);
    await ctx.exec(command, args);
  } catch (err) {
    log.debug('killTmuxSession: tmux session not found or already dead', {
      sessionName,
      error: String(err),
    });
  }
}
