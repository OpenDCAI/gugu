/**
 * #6264 咕咕 server 起的一切(agent、「编程」终端、tmux、git)都跑在 UTF-8 locale 里。
 *
 * 最小化的云主机 / 容器 / systemd 用户服务常常根本没设 LANG:`locale` → POSIX,于是 `ls` 把中文文件名
 * 打成 `$'\347…'`、bash 的输入行里敲不进中文。我们的用户几乎全是中文路径,这是默认就撞的坑。
 *
 * 照 VS Code 终端的 `terminal.integrated.detectLocale`(https://code.visualstudio.com/docs/terminal/advanced
 * 「Interaction with $LANG」):当前的 locale 不是 UTF-8 时补一个 UTF-8 的,是 UTF-8 就一个字不动。挑哪一个:
 *  ① 用户登录 shell 里设过的(rc 里 export 的 LANG / LC_ALL / LC_CTYPE),只要这台机器上真有;
 *  ② 否则 C.UTF-8(与语言无关、不改变程序的提示语言);没有就 en_US.UTF-8;再没有就随便一个 UTF-8 的;
 *  ③ 列不出这台机器有哪些 locale(没有 `locale` 命令,例如 Alpine/musl —— 那里本来就按 UTF-8 处理)
 *     ⇒ 照样填 C.UTF-8。
 * 只改本进程的环境;之后起的每个子进程都继承它(终端整份继承、agent 经 buildAgentEnv 的 LANG 白名单)。
 * 纯函数(可用 locale 列表注入),每条分支都有单测。
 */
import { execFileSync } from 'node:child_process'

/** `UTF-8` / `utf8` / `UTF8` 都是同一个东西(glibc 把 codeset 名字归一化后再比)。 */
export function isUtf8Locale(value: string | undefined): boolean {
  return typeof value === 'string' && /\.utf-?8(@|$)/i.test(value.trim())
}

function normalize(name: string): string {
  const [base, codeset = ''] = name.trim().split('.', 2)
  return `${base}.${codeset.toLowerCase().replace(/-/g, '')}`
}

/** 此刻起作用的那一格:LC_ALL 最大,其次 LC_CTYPE(字符分类只看它),最后 LANG。 */
export function effectiveCtype(env: NodeJS.ProcessEnv): string | undefined {
  return env.LC_ALL?.trim() || env.LC_CTYPE?.trim() || env.LANG?.trim() || undefined
}

export type Utf8LocaleFix = {
  /** 设成什么(写进 LANG);null = 已经是 UTF-8,不用动。 */
  lang: string | null
  /** 也要改成同一个值的格:值不是 UTF-8 的 LC_ALL / LC_CTYPE 会压过 LANG。改写而❌ 删掉 —— 登录 shell 快照里
   *  也记着启动时那一份,删掉的话它会从 agent 环境的底座里再冒出来(buildUserShellBaseEnv 里本进程的环境压过快照)。 */
  override: Array<'LC_ALL' | 'LC_CTYPE'>
  /** 为什么选它(进日志)。 */
  source: 'already' | 'login-shell' | 'fallback'
}

export function planUtf8Locale(input: {
  env: NodeJS.ProcessEnv
  /** 登录 shell 采到的环境(没采到 = null)。 */
  loginEnv: Record<string, string> | null
  /** 这台机器上有的 locale(`locale -a`);列不出来 = null。 */
  available: readonly string[] | null
}): Utf8LocaleFix {
  if (isUtf8Locale(effectiveCtype(input.env))) return { lang: null, override: [], source: 'already' }
  const override = (['LC_ALL', 'LC_CTYPE'] as const).filter((key) => input.env[key]?.trim() && !isUtf8Locale(input.env[key]))
  const known = input.available ? new Set(input.available.map(normalize)) : null
  const exists = (name: string) => !known || known.has(normalize(name))

  const fromLogin = input.loginEnv ? effectiveCtype(input.loginEnv) : undefined
  if (fromLogin && isUtf8Locale(fromLogin) && exists(fromLogin)) return { lang: fromLogin, override, source: 'login-shell' }

  if (!input.available) return { lang: 'C.UTF-8', override, source: 'fallback' }
  const preferred = ['C.UTF-8', 'en_US.UTF-8'].find(exists)
  const any = input.available.find((name) => isUtf8Locale(name))
  // 一个 UTF-8 的都没有:还是填 C.UTF-8 —— glibc 2.35 起内置它,更老的机器上最坏也只是等于没设(与现在一样)。
  return { lang: preferred ?? any ?? 'C.UTF-8', override, source: 'fallback' }
}

function listAvailableLocales(): string[] | null {
  try {
    const out = execFileSync('locale', ['-a'], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] })
    const names = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    return names.length > 0 ? names : null
  } catch {
    return null
  }
}

/**
 * 在 server 账号进程里调一次(登录 shell 采样之后)。返回做了什么,调用方打日志。
 * 已经是 UTF-8 时不起任何进程。
 */
export function ensureUtf8Locale(
  loginEnv: Record<string, string> | null,
  env: NodeJS.ProcessEnv = process.env,
  available: () => readonly string[] | null = listAvailableLocales,
): Utf8LocaleFix {
  if (isUtf8Locale(effectiveCtype(env))) return { lang: null, override: [], source: 'already' }
  const fix = planUtf8Locale({ env, loginEnv, available: available() })
  for (const key of fix.override) if (fix.lang) env[key] = fix.lang
  if (fix.lang) env.LANG = fix.lang
  return fix
}
