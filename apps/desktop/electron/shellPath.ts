import { execFileSync } from 'node:child_process'
import { win32 as winPath } from 'node:path'
import {
  buildExternalToolEnv,
  SHELL_ENV_CAPTURE_GUARD,
} from './session/main/utils/childProcessEnv'
import { getWindowsEnvValue, prependWindowsPathEntry } from './session/main/utils/windows-env'

const FIELD_DELIMITER = '\x1f'
const ENV_RECORD_DELIMITER = '\x1e'
const SHELL_TIMEOUT_MS = 5000

/**
 * 采样脚本 —— 一次 shell、两件产出(#5873)。
 *
 * 1. `printf` 那一段是 **PATH 的保底**:纯 shell 内建,没有任何外部依赖,所以 PATH 补救
 *    永远不会因为第二段取不到而回退。
 * 2. `awk` 那一段把**整份**环境按 `NAME=VALUE\x1e` 吐出来。用 awk 的 `ENVIRON` 而不是
 *    `env` / `printenv`:后两者按行输出,值里只要有换行(PEM、多行脚本)就会被行解析截断,
 *    而且**静默**截断。`ENVIRON` + 一个 0x1E 记录分隔符没有这个歧义。
 *    awk 是 POSIX 必备(macOS 自带 BSD awk、各发行版自带 gawk/mawk/busybox awk);真取不到
 *    时第二段为空,退化成「只补 PATH」= 修这一票之前的行为,❌ 不是新的坏法。
 *
 * 两段都包在 0x1F 之间:rc 文件的 banner / 欢迎语会混进 stdout,靠分隔符切出来才不受影响。
 */
const ENV_CAPTURE_SCRIPT =
  `printf "\\037%s\\037" "$PATH"; ` +
  `awk 'BEGIN{for (k in ENVIRON) printf "%s=%s\\036", k, ENVIRON[k]}' 2>/dev/null; ` +
  `printf "\\037"`

/**
 * csh / tcsh 的同一段(#6264)。两处不同,都是照 VS Code 的 shellEnv.ts(tcsh/csh 走 `-ic`,其余 `-i -l -c`):
 *  · csh 不认 `-l` 与别的选项连写(`tcsh -lic` → Unknown option),登录 shell 的 rc 由 `-i` 读的 `.cshrc` 兜住;
 *  · csh 没有 `2>` 这种写法 —— `awk … 2>/dev/null` 会把 `2` 当成 awk 的参数、把**标准输出**扔进 /dev/null,
 *    整份环境就没了。所以这里不带那个重定向(awk 缺失时 csh 自己往 stderr 报一句,不碍事)。
 * fish 用 POSIX 那一段就行:`"$PATH"` 在 fish 里按 `:` 连起来,`2>` 与 `printf` 的八进制转义都认。
 */
const CSH_ENV_CAPTURE_SCRIPT =
  `printf "\\037%s\\037" "$PATH"; ` +
  `awk 'BEGIN{for (k in ENVIRON) printf "%s=%s\\036", k, ENVIRON[k]}'; ` +
  `printf "\\037"`

/** 按登录 shell 的种类给采样参数(纯函数,单测钉住)。 */
export function loginShellProbeArgs(shell: string): string[] {
  const name = shell.split('/').pop() ?? ''
  return name === 'csh' || name === 'tcsh' ? ['-ic', CSH_ENV_CAPTURE_SCRIPT] : ['-lic', ENV_CAPTURE_SCRIPT]
}

export type ShellPathProbe = (
  shell: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => string

const probeLoginShellPath: ShellPathProbe = (shell, args, env) =>
  execFileSync(shell, args, {
    encoding: 'utf8',
    timeout: SHELL_TIMEOUT_MS,
    env,
  })

export type LoginShellPathResult =
  | { hydrated: true; path: string }
  | { hydrated: false; reason: 'windows' | 'probe-failed' | 'invalid-output' }

/**
 * 最近一次采样到的**整份**登录 shell 环境(#5873)。
 *
 * ⚠️ 它**不写回** `process.env` —— 只有 PATH 那一格写回(见 `hydrateLoginShellPath`)。
 * 把整份灌进 GUI 主进程会污染 app 自己的运行环境(AppImage 的 `LD_LIBRARY_PATH` 一类,#2895);
 * 合并只发生在 spawn 侧,由 `buildUserShellBaseEnv` 负责。
 *
 * 取不到时保持上一次的值(采样失败是降级、不是「用户的环境空了」)。
 */
let lastLoginShellEnv: Record<string, string> | null = null

/**
 * 最近一次采样到的登录 shell 环境;从未采到(Windows / 采样失败 / 没有 awk)则 null。
 *
 * 宿主把它注入给会话页(`setLoginShellEnvProvider`)—— ❌ 会话页不要相对 import 本模块:
 * 这里有模块级状态,跨 bundle 只会拿到读不到的复制品。同 `setLoginShellPathRehydrator`。
 */
export function loginShellEnvSnapshot(): Record<string, string> | null {
  return lastLoginShellEnv
}

/**
 * `NAME=VALUE\x1e` 串 → map。名字不合法的记录直接丢(rc 的 banner 混进来时是它挡着)。
 *
 * `SHELL_ENV_CAPTURE_GUARD` 的那几个名字**整格丢掉**,不是丢值:它们是**我们**塞给探测 shell 的
 * (`DISABLE_AUTO_UPDATE` 让 oh-my-zsh 别去查更新、`ZSH_TMUX_AUTOSTART*` 让 tmux 插件别 attach),
 * 采回来的那一份里当然有它们 —— 但那描述的是这次探测,不是用户的登录环境。原样传下去 =
 * 咕咕起的每一条会话都被告知「自动更新关了 / 你已经在 tmux 里了」,而用户从没那么配过。
 * ⚠️ 也**不能**改成「只在值等于我们塞的那个时丢」:用户 rc 里真写了同名 export 时,采回来的
 * 就是他那份,两种情况在这一层分不开 —— 分不开就别猜,丢掉比报一个可能是我们自己编的值诚实。
 * (2026-09-19 实测:未修前这三格随快照进了 codex 的进程环境。)
 */
function parseCapturedEnv(payload: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const record of payload.split(ENV_RECORD_DELIMITER)) {
    const eq = record.indexOf('=')
    if (eq <= 0) continue
    const key = record.slice(0, eq)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    // `Object.hasOwn` 而非 `in`:`in` 会把 `toString` / `constructor` 这些原型上的名字也
    // 算成命中,而它们都是合法的环境变量名。
    if (Object.hasOwn(SHELL_ENV_CAPTURE_GUARD, key)) continue
    env[key] = record.slice(eq + 1)
  }
  return env
}

/**
 * 登录 PATH 在前(它才是用户心目中的 PATH),启动方已有的条目补在后、去重。
 *
 * ❌ 不能直接覆盖：启动方常特意前置路径，冲掉就坏。CI 机上的 ci-run-app.sh 开头就是
 * `export PATH=/opt/hostedtoolcache/node/24.14.0/x64/bin:$PATH` —— 覆盖等于把 node 弄丢。
 */
function mergePath(loginPath: string, currentPath: string): string {
  const loginEntries = loginPath.split(':').filter(Boolean)
  const seen = new Set(loginEntries)
  const extra = currentPath.split(':').filter((p) => p && !seen.has(p))
  return [...loginEntries, ...extra].join(':')
}

/**
 * 最近一次 PATH 补救的结果。**为什么要留**:补救原来是一句 fire-and-forget —— 探测 shell 失败
 * 或输出被 rc 文件的 banner 污染时,函数如实返回了 reason,却没有任何调用点看它。用户那头只
 * 看见「agent CLI 未安装」,而真因(PATH 没补上)一点痕迹都不留,连事后都查不出来。
 *
 * 这里只记不判:谁报错谁去读它,把「当时 PATH 补没补上」写进那条错误里。
 * ❌ 不在这里替用户猜路径(比如硬塞 /opt/homebrew/bin)—— 那是拿兜底盖症状。
 */
let lastLoginShellPath: LoginShellPathResult | null = null;

function recordLoginShellPath(result: LoginShellPathResult): LoginShellPathResult {
  lastLoginShellPath = result
  return result
}

/** 最近一次 `hydrateLoginShellPath()` 的结果;从未跑过则 null。 */
export function loginShellPathDiagnosis(): LoginShellPathResult | null {
  return lastLoginShellPath
}

/**
 * 采一次用户登录 shell 的环境:PATH 合并进当前进程,**整份**留在 `loginShellEnvSnapshot()` 里。
 *
 * 曾经这里只取 PATH(源码原话:"imports PATH only")。代价是 #5873 那一票:用户按常规把
 * `S2T_API_KEY` / `HTTP_PROXY` export 在 `~/.zshrc`,终端会话(`zsh -il`)读得到,而代码 / TUI
 * 会话(`zsh -c`,非交互非登录)与聊天(ACP)会话(裸 spawn,任何 rc 都不经过)一个都读不到 ——
 * 「找得到二进制(PATH 到了)却报 Missing environment variable」。同一次采样把整份带回来,
 * 成本为零(同一个 shell、同一次往返),合并在 spawn 侧(`buildUserShellBaseEnv`)。
 *
 * 为什么必须做：app 要 spawn 用户装的 CLI（codex / claude / git / node）。PATH 残缺时
 * 探测器的 `which -a` 一个都找不到 → 每个 agent 都报「未安装」→ UI 给出「安装」→
 * `npm install -g` 撞上已存在的二进制 → EEXIST。一条链看着像三个 bug，实为一个。
 *
 * 为什么不挑启动方式：旧实现是 `platform !== 'darwin' || !isPackaged` 就跳过 —— 那是在
 * 猜「谁启动了我」，而进程判断不了这个。实际漏掉三类：
 *   · mac 上从 ssh / agent / 自动化 shell 起（非登录 shell 的 PATH 常只剩四项）；
 *   · Linux **任何**启动方式，含打包后双击 —— 真实用户同样中招；
 *   · mac/Linux 上任何未打包的验证流程。
 * 代价是启动时多一次 shell（实测 mac zsh ≈108ms / Linux bash ≈73–130ms），换掉一整类
 * 静默故障。取不到就如实返回 false，❌ 不假装补好了。
 *
 * AppImage（#1679）：咕咕的 Linux 产物是 AppImage，运行时 env 带着 APPIMAGE/APPDIR/ARGV0/OWD，
 * PATH 里含 `/tmp/.mount_*` —— 即 AppImage 自己的挂载点。这里起的是**登录 + 交互** shell，
 * 会 source 用户的 rc 文件；里面的钩子（mise/starship/oh-my-zsh）按名字通过 PATH 找二进制时
 * 会重新进入 AppImage，把 app fork 炸掉。所以交给探测 shell 的必须是 buildExternalToolEnv()
 * 擦洗过的**副本** —— 本进程自己的 env 不动（updater 要读 APPIMAGE，挂载点是 app 找自带
 * 二进制的落点）。本体其余外部工具 spawn 点也都逐次走同一个擦洗函数。
 *
 * 顺带叠上 SHELL_ENV_CAPTURE_GUARD：否则 rc 里的自动更新检查/tmux 自动 attach 会把这次探测
 * 拖到 5 秒超时。
 *
 * Windows 例外：那边没有登录 shell 的概念，PATH 由用户环境/注册表给、GUI 进程正常继承；
 * 它的缺口（npm 全局 bin）由 ensureWindowsNpmGlobalBinInPath() 单独补，不起进程。
 */
export function hydrateLoginShellPath({
  platform = process.platform,
  env = process.env,
  probe = probeLoginShellPath,
}: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  probe?: ShellPathProbe
} = {}): LoginShellPathResult {
  if (platform === 'win32') {
    return recordLoginShellPath({ hydrated: false, reason: 'windows' })
  }

  const shell = env.SHELL?.trim() || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  // ❌ 不能把本进程的 env 原样交给探测 shell。见函数注释的 AppImage 一节。
  const probeEnv = { ...buildExternalToolEnv(env), ...SHELL_ENV_CAPTURE_GUARD }
  let output: string
  try {
    output = probe(shell, loginShellProbeArgs(shell), probeEnv)
  } catch {
    return recordLoginShellPath({ hydrated: false, reason: 'probe-failed' })
  }

  const fields = output.split(FIELD_DELIMITER)
  const loginPath = fields[1]
  // 整份环境:采到就记下,采不到(没有 awk)就保持上一次 —— ❌ 不清空,那会让「装完重采一次」
  // 在一台没有 awk 的机器上把已有的快照抹掉。
  const capturedEnv = parseCapturedEnv(fields[2] ?? '')
  if (Object.keys(capturedEnv).length > 0) lastLoginShellEnv = capturedEnv

  if (!loginPath || !loginPath.includes('/')) {
    return recordLoginShellPath({ hydrated: false, reason: 'invalid-output' })
  }

  const merged = mergePath(loginPath, env.PATH ?? '')
  env.PATH = merged
  return recordLoginShellPath({ hydrated: true, path: merged })
}

/**
 * Windows 上把 npm 全局 bin（`%APPDATA%\npm`）前置进 PATH，返回加进去的那条、没加则 null。
 *
 * 为什么单列：Windows 没有登录 shell，上面那套取不到东西；而 `npm install -g` 装的 CLI
 * （codex 就是其一）正落在这里。GUI 进程通常能从用户环境继承到它，但 npm 是在**安装时**
 * 写进用户 PATH 的 —— 装完没重开会话、或从服务/CI 上下文起的进程，就拿不到。
 * 代价接近零：只读一个环境变量再拼路径，不起任何进程。
 *
 * ❌ 别在非 Windows 上调它有效：那边的落点由登录 shell 的 PATH 覆盖，重复前置只会制造噪音。
 *
 * 「环境变量名大小写不敏感」「PATH 前置去重」这两件事 windows-env.ts 已经做好了，用它 ——
 * 手搓第二份就是 #2802 要消灭的那种「两份独立实现」。
 */
export function ensureWindowsNpmGlobalBinInPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform !== 'win32') return null

  const appData = getWindowsEnvValue(env, 'APPDATA')
  if (!appData) return null

  const npmBin = winPath.join(appData, 'npm')
  return prependWindowsPathEntry(env, npmBin) ? npmBin : null
}
