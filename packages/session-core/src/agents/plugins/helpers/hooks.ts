export type HookCommandOptions = {
  platform?: NodeJS.Platform;
};

/** 咕咕写进各家 agent 配置的钩子条目,命令体里一定带着这个变量名 —— 「这条是咕咕的」靠它认。 */
export const GUGU_HOOK_MARKER = 'GUGU_HOOK_PORT';

/**
 * 改名前(`EMDASH_*` 那一套)写下的钩子条目带的标记。仍然算咕咕自己的:每次起会话前都会重写钩子,
 * 旧条目就在那一刻被剔掉、换成新条目。
 * ❌ 只用于「剔除咕咕的条目」,不用于「装没装」—— 只剩旧条目 = 还没换成新协议,新会话收不到它的回传。
 */
export const LEGACY_HOOK_MARKER = 'EMDASH_HOOK_PORT';

/** 这段文本是不是咕咕写的钩子(改名前后两种标记都算)。 */
export function isGuguHookText(text: string): boolean {
  return text.includes(GUGU_HOOK_MARKER) || text.includes(LEGACY_HOOK_MARKER);
}

/** Filter out gugu-managed entries (current or pre-rename marker) from a hook array. */
export function filterUserHooks<T>(entries: T[], stringify?: (entry: T) => string): T[] {
  const toStr = stringify ?? JSON.stringify;
  return entries.filter((entry) => !isGuguHookText(toStr(entry)));
}

// ── Internal helpers ────────────────────────────────────────────────────────

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

type HookPostPayload = 'stdin' | { json: Record<string, string> };

/**
 * The POSIX half of the hook post, guarded the same way the Windows half already was.
 *
 * Two protections the Windows branch has had all along and this one did not, each
 * for a failure this shape actually produced:
 *
 * 1. **The env guard.** These hooks are written into the agent's GLOBAL config
 *    (`~/.codex/config.toml` and friends), so they run for every session that CLI
 *    ever starts — including ones gugu did not spawn, where the three variables
 *    are simply absent. Unguarded, `$GUGU_HOOK_PORT` expands to nothing and the
 *    URL becomes `http://127.0.0.1:/hook` — port 80 on the user's own machine,
 *    i.e. whatever *else* they happen to run there.
 * 2. **`-o /dev/null`.** `curl -f` fails on 4xx/5xx but NOT on 3xx, and `|| true`
 *    only swallows the exit code — never the output. So the moment something on
 *    port 80 answered with a redirect, that page's HTML landed on the hook's
 *    stdout, and an agent that expects JSON there reported the hook as broken.
 *    (Observed on a dev box whose nginx default_server 301'd unknown hosts. The
 *    redirect only made it visible: without it the same call was failing all
 *    along, silently, against whatever port 80 held.)
 *
 * The stdin payload is drained on the skip path rather than left unread, so the
 * agent writing it gets EOF instead of a broken pipe.
 */
function makePosixHookPostCommand(eventType: string, payload: HookPostPayload): string {
  const payloadPart =
    payload === 'stdin' ? '-d @- ' : `--data-binary '${JSON.stringify(payload.json)}' `;
  const post =
    'curl -sf -o /dev/null -X POST ' +
    '-H "Content-Type: application/json" ' +
    '-H "X-Gugu-Token: $GUGU_HOOK_TOKEN" ' +
    '-H "X-Gugu-Pty-Id: $GUGU_PTY_ID" ' +
    `-H "X-Gugu-Event-Type: ${eventType}" ` +
    payloadPart +
    '"http://127.0.0.1:$GUGU_HOOK_PORT/hook" || true';
  const skip = payload === 'stdin' ? 'cat > /dev/null' : ':';
  return (
    'if [ -n "$GUGU_HOOK_PORT" ] && [ -n "$GUGU_HOOK_TOKEN" ] && [ -n "$GUGU_PTY_ID" ]; ' +
    `then ${post}; else ${skip}; fi`
  );
}

/** A PowerShell expression reading an environment variable, spelled without `$` (see below). */
export function powerShellEnv(name: string): string {
  return `[Environment]::GetEnvironmentVariable(${quotePowerShellString(name)})`;
}

/** The hook's stdin, decoded as the UTF-8 the agent writes — not as the console code page (GBK on zh-CN). */
const POWERSHELL_STDIN_TEXT =
  '[IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8).ReadToEnd()';

/** `@{ k = 'v' } | ConvertTo-Json` builds the JSON body, since a JSON literal would need `"`. */
function powerShellJsonExpression(json: Record<string, string>): string {
  const fields = Object.entries(json).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Windows hook JSON key must be a plain identifier, got ${JSON.stringify(key)}`);
    }
    return `${key} = ${quotePowerShellString(value)}`;
  });
  return `(@{ ${fields.join('; ')} } | ConvertTo-Json -Compress)`;
}

/**
 * PowerShell that posts `bodyExpression` (a PowerShell expression yielding the JSON text) to the
 * gugu hook server, or does nothing when the session was not started by gugu.
 */
export function makeWindowsHookPostScript(eventType: string, bodyExpression: string): string {
  const port = powerShellEnv(GUGU_HOOK_MARKER);
  const token = powerShellEnv('GUGU_HOOK_TOKEN');
  const ptyId = powerShellEnv('GUGU_PTY_ID');
  return [
    `if (-not ${port} -or -not ${token} -or -not ${ptyId}) { exit 0 }`,
    'Set-Variable -Name ProgressPreference -Value SilentlyContinue',
    'try { Invoke-WebRequest -UseBasicParsing -Method POST -ErrorAction Stop ' +
      `-Uri ('http://127.0.0.1:' + ${port} + '/hook') ` +
      "-ContentType 'application/json; charset=utf-8' " +
      `-Headers @{ 'X-Gugu-Token' = ${token}; 'X-Gugu-Pty-Id' = ${ptyId}; ` +
      `'X-Gugu-Event-Type' = ${quotePowerShellString(eventType)} } ` +
      `-Body ([Text.Encoding]::UTF8.GetBytes(${bodyExpression})) | Out-Null } catch { exit 0 }`,
  ].join('; ');
}

function makeWindowsHookPostCommand(eventType: string, payload: HookPostPayload): string {
  const body = payload === 'stdin' ? POWERSHELL_STDIN_TEXT : powerShellJsonExpression(payload.json);
  return makeWindowsPowerShellHookCommand(makeWindowsHookPostScript(eventType, body));
}

/**
 * Inside plain double quotes, each of these still means something to at least one shell a hook
 * may run under: `$` and backtick expand in Git Bash and PowerShell, `\` escapes in Git Bash,
 * `%` and `!` expand in cmd.exe, `"` ends the quoting, and a line break ends the command.
 */
const WINDOWS_HOOK_SCRIPT_UNSAFE = /["$`%!\\\r\n]/;

/**
 * One command line that runs `script` the same way whichever shell the agent hands it to.
 *
 * Agents run hook commands through different shells on Windows: Claude Code uses Git Bash when it
 * is installed and PowerShell otherwise, and Node-based agents use cmd.exe. The previous shape —
 * `cmd.exe /d /c echo GUGU_HOOK_PORT>NUL&&powershell.exe -EncodedCommand …` — only parsed in
 * cmd.exe: Windows PowerShell 5.1 rejects `&&`, so the hook never ran and its GBK error text showed
 * up garbled in Claude's TUI; Git Bash rewrote `/d /c` into drive paths, so cmd.exe went interactive,
 * swallowed the event payload as a command and left a file named `NUL` behind.
 *
 * Here the script sits inside double quotes after `powershell.exe -Command`, which all three shells
 * pass through verbatim as long as it avoids {@link WINDOWS_HOOK_SCRIPT_UNSAFE}. Readable text rather
 * than `-EncodedCommand` also keeps {@link GUGU_HOOK_MARKER} in the command, which is how gugu
 * recognises its own entries.
 */
export function makeWindowsPowerShellHookCommand(script: string): string {
  const unsafe = WINDOWS_HOOK_SCRIPT_UNSAFE.exec(script);
  if (unsafe) {
    throw new Error(
      `Windows hook script contains ${JSON.stringify(unsafe[0])}, which some hook shell would rewrite`
    );
  }
  if (!script.includes(GUGU_HOOK_MARKER)) {
    throw new Error(`Windows hook script must reference ${GUGU_HOOK_MARKER} so gugu can recognise it`);
  }
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${script}"`;
}

/** Post an event with an arbitrary payload, platform-aware. */
export function makeHookPostCommand(
  eventType: string,
  payload: HookPostPayload,
  opts: HookCommandOptions
): string {
  return (opts.platform ?? process.platform) === 'win32'
    ? makeWindowsHookPostCommand(eventType, payload)
    : makePosixHookPostCommand(eventType, payload);
}

// ── Public command builders ─────────────────────────────────────────────────

/**
 * Standard stdin-piped hook command.
 * The agent pipes the event JSON body through stdin.
 */
export function makeStdinHookCommand(eventType: string, opts: HookCommandOptions = {}): string {
  return makeHookPostCommand(eventType, 'stdin', opts);
}

/**
 * Fixed-body notification hook command.
 * Sends a JSON body with a `notification_type` key (used by Codex-style events).
 */
export function makeNotificationHookCommand(
  notificationType: 'idle_prompt' | 'permission_prompt',
  opts: HookCommandOptions = {}
): string {
  return makeHookPostCommand(
    'notification',
    { json: { notification_type: notificationType } },
    opts
  );
}
