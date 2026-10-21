// @@@logging (#2382) - 主进程的结构化日志基座。
//
// 为什么要有它:此前全仓 95 处裸 `console.*`,打包后一行都落不了盘 —— 用户端出问题拿不到证据,
// 开发期排障也只能靠猜。实测代价:会话页 codex 那条腿 agent 一轮跑完零输出,而 gugu 侧一条日志都没有,
// 最后只能去翻 codex 自己的 rollout 才定位到。
//
// 选型 = pino:与会话页(apps/desktop/electron/session/)的 logger 同引擎,
// 两半的日志是同一种 JSON 行,可以合并成一条时间线查
// (会话页尤其需要:主进程与会话页 bridge 交替出现)。❌ 不用 electron-log(默认非结构化,量一大查不动)。
//
// 两条纪律:
// ① **不用 pino transport / worker**:Electron 主进程里 worker_threads 起 transport 容易在打包后炸,
//    这里用 multistream + 普通可写流,进程内同步写,行为可预期。
// ② **落盘前脱敏**:token / key / password / authorization / service_role 一律打码(CLAUDE.md 红线),
//    既走 pino 的字段级 redact,也对自由文本做正则打码 —— 密钥经常是拼在 URL 或错误消息里的。
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import pino, { multistream, type Logger as PinoLogger } from 'pino'

/** 单文件上限,超了就轮转;保留 KEEP 份历史。日志是给人发回来看的,别让它无限长。 */
const MAX_BYTES = 5 * 1024 * 1024
const KEEP = 3

export interface LoggerOptions {
  /** 日志目录;缺省用 Electron 的 userData/logs(拿不到 electron 时退到 GUGU_LOG_DIR / 不落盘)。 */
  dir?: string
  level?: pino.Level
  /** 是否同时往 stdout 打人话(dev 默认开)。 */
  stdout?: boolean
  /** 单文件轮转上限,默认 5MB。单测用它把轮转做小,❌ 生产别调。 */
  maxBytes?: number
}

// ── 脱敏 ────────────────────────────────────────────────────────────────
// 字段名匹配到就整值打码;自由文本里的常见密钥形态也打码(它们常拼在 URL / 错误消息里)。
// ⚠ 这张表是**允许有漏网的**:名字没命中就落明文。加字段前先想一遍新形态(cookie / 私钥 / 签名都曾不在表内)。
const SECRET_KEY = /^(.*(token|secret|password|passwd|passphrase|authorization|credential|cookie|api[-_]?key|private[-_]?key|service[-_]?role|anon[-_]?key|signature).*)$/i
const SECRET_TEXT: Array<[RegExp, string]> = [
  // 私钥块放在最前是**防御性**的:它是这张表里唯一跨行的规则,先跑一遍就不必去想「后面某条
  // 单行规则会不会咬进块体、让收尾的 -----END----- 配不上」。
  // ⚠ 这条排序**当前判据未验证**:把它挪到表尾,全套测试照绿 —— 因为现有规则都够不着 PEM 的
  // base64 块体(要么要点号、要么要 `sk-`/`gh*_` 前缀)。⇒ 它防的是**将来**新加的宽规则,
  // 不是一个今天就成立的漏洞。别把它读成已验证的事实。
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '«private-key»'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '«jwt»'], // supabase / JWT
  [/sk-[A-Za-z0-9_-]{12,}/g, '«sk-key»'],
  // GitHub 令牌:gh[pousr]_ 是 classic/OAuth/server/refresh,github_pat_ 是 fine-grained。
  // 仓里 gh CLI 用得重,它出现在 spawn 报错与远端拒绝消息里的机会很实。
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '«gh-token»'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '«gh-token»'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '«aws-key»'],
  // URL / 连接串里内联的凭据。只抹密码那一段,scheme 与用户名留着 —— 「连哪台、以谁的身份」
  // 正是排查要看的,整条打掉等于把日志写废。postgres://user:pw@host 与 https://user:pw@host 同形。
  // ⚠ scheme 必须**有长度上限**。写成 `[a-z][a-z0-9+.-]*` 时,它会在长行上先吞完整行再
  // 回溯找 `://`,每个起始位置来一遍 = O(n²):实测一条 64KB 的行要 11 秒(其余八条全是
  // 亚毫秒 —— 那就是阳控,证明慢的是那一条不是机器)。而 redactText 挂在 pino 的 hook 上、
  // **每行日志都过** —— 一条长堆栈就能冻住主进程。真实 scheme 都很短,16 字符够用。
  [/([a-z][a-z0-9+.-]{0,15}:\/\/)([^\s/@:]+):[^\s/@]+@/gi, '$1$2:«redacted»@'],
  [/(bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1«token»'],
  [/((?:token|api[-_]?key|secret|password|passwd)["'\s:=]+)([A-Za-z0-9._-]{8,})/gi, '$1«redacted»'],
]

/**
 * 命令行数组里「上一个元素是取密钥的开关、下一个元素就是密钥」的形状。
 *
 * 上面那条关键词规则要求**关键词与值在同一个字符串里**,而 argv 天生把它俩劈成两个数组元素
 * (`['gh','auth','login','--with-token', <PAT>]`) —— 于是整条 spawn 参数明文落盘。
 * 这不是规则写窄了,是它压根够不着这个形状。
 */
// ⚠ 表里**不放**裸 `key` / `private-key`:那类开关的值通常是**文件路径**,抹掉它等于把
// 「用的哪把钥匙」这条排查线索一起删了,而路径本身不是秘密。
const SECRET_FLAG = /^-{1,2}(?:[a-z0-9-]*-)?(?:token|password|passwd|secret|api[-_]?key)$/i

export function redactText(text: string): string {
  let out = text
  for (const [re, to] of SECRET_TEXT) out = out.replace(re, to)
  return out
}

/**
 * 深度脱敏:字段名命中 → 整值打码;字符串 → 正则打码。循环引用直接放弃(日志不该为此崩)。
 *
 * 深度封顶:递归无上限的话,一个深层嵌套对象(renderer 回传、第三方错误对象都可能很深)会在 pino 的 hook 里
 * 爆栈 —— 而那处没有 try,等于**一条日志把调用方打挂**。截断比崩强。
 */
const MAX_DEPTH = 12
export function redactValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') return redactText(value)
  if (!value || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '«too-deep»'
  if (seen.has(value as object)) return '«circular»'
  // ⚠ 这些类型不能走 Object.entries:Date/Map/Set 会被拍成 `{}`(时间戳直接没了),
  // Buffer/TypedArray 会被展开成「一个字节一个键」—— 一条 1MB 的 buffer 就是 100 万个键(review 指出)。
  if (value instanceof Date) return value.toISOString()
  if (value instanceof RegExp) return String(value)
  if (Buffer.isBuffer(value)) return `«buffer ${value.length}B»`
  if (ArrayBuffer.isView(value)) return `«${value.constructor?.name ?? 'typedarray'} ${(value as { length?: number }).length ?? '?'}»`
  if (value instanceof Map) return { '«map»': value.size }
  if (value instanceof Set) return { '«set»': value.size }
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), stack: redactText(value.stack ?? '') }
  }
  // seen 只该记「当前这条路径」:同一个对象被引用两次(DAG,不是环)不该被打成 «circular» —— 那会把真正
  // 要看的载荷抹掉,还谎报了一个不存在的环。所以递归完要退出来。
  seen.add(value as object)
  try {
    if (Array.isArray(value)) {
      return value.map((v, i) => (
        typeof v === 'string' && typeof value[i - 1] === 'string' && SECRET_FLAG.test(value[i - 1] as string)
          ? '«redacted»'
          : redactValue(v, seen, depth + 1)
      ))
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '«redacted»' : redactValue(v, seen, depth + 1)
    }
    return out
  } finally {
    seen.delete(value as object)
  }
}

// ── 目的地 ──────────────────────────────────────────────────────────────
/** 文件当前大小(不存在算 0)。 */
function fileSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** 把 a.log → a.log.1 → a.log.2 …,只保留 KEEP 份。 */
function rotateNow(file: string): void {
  for (let i = KEEP - 1; i >= 1; i -= 1) {
    try {
      renameSync(`${file}.${i}`, `${file}.${i + 1}`)
    } catch {
      /* 没有就跳过 */
    }
  }
  try {
    renameSync(file, `${file}.1`)
  } catch {
    /* 轮转失败不该让 app 起不来 */
  }
}

const LEVEL_LABEL: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' }

/**
 * 直接 `writeSync(1)`,❌ 不走 `process.stdout.write`:测试框架/宿主会替换 stdout,在一个 Writable 里
 * 再调它会绕回自己 —— 实测在 vitest 下直接死锁(整个用例挂住,不报错)。写 fd 是最短、最不会打架的路。
 */
// stdout 开关是**运行期可变**的:模块级 createLogger 必然早于 main.ts 那次 initLogging(见 LateFileSink),
// 所以 stdout 不能在建流时定死 —— 否则调用方传的 `stdout:false` 永远不生效(review 指出,单测里也确实没生效)。
let stdoutEnabled = process.env.GUGU_LOG_STDOUT === '1' || process.env.GUGU_LOG_STDOUT === undefined

function writeStdout(line: string): void {
  if (!stdoutEnabled) return
  try {
    writeSync(1, line)
  } catch {
    /* stdout 关了/满了都不该让日志把调用方拖垮 */
  }
}

/** 给人看的一行:`12:34:56 INFO  [scope] 消息 {额外字段}`。❌ 不起 worker(见文件头纪律①)。 */
function humanStream(): Writable {
  return new Writable({
    write(chunk, _enc, cb) {
      let line = ''
      try {
        const o = JSON.parse(chunk.toString()) as Record<string, unknown>
        const t = new Date(Number(o.time) || Date.now()).toTimeString().slice(0, 8)
        const lvl = (LEVEL_LABEL[Number(o.level)] ?? '?').toUpperCase().padEnd(5)
        const scope = o.scope ? `[${String(o.scope)}] ` : ''
        const rest = { ...o }
        for (const k of ['time', 'level', 'scope', 'msg', 'pid', 'hostname']) delete rest[k]
        const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ''
        line = `${t} ${lvl} ${scope}${String(o.msg ?? '')}${extra}\n`
      } catch {
        line = chunk.toString()
      }
      writeStdout(line)
      cb()
    },
  })
}

/**
 * 目录由**调用方**给(main.ts 传 `userData/logs`),logger 本身不认识 electron ——
 * 这样它在单测/脚本/未来的 CLI 里都能直接用,不用为了一个路径去 mock 整个 electron。
 * 都没有 → 只打 stdout(不落盘),而不是猜一个位置。
 */
function resolveDir(explicit?: string): string | null {
  return explicit ?? process.env.GUGU_LOG_DIR ?? null
}

/**
 * 「目录会迟到」的文件目的地。
 *
 * 为什么必须这样:`acp-host.ts` / `acp-bridge-impl.ts` 在**模块级**就 `createLogger(...)`,而 main.ts 要等
 * `app.setPath('userData')` 之后才知道日志目录 —— import 求值早于导入方的函数体,所以"没目录"的那次 init
 * **必然先跑**。早期版本在这里幂等早退,结果整个 app 一行都不落盘、还一声不响(单测先调 initLogging,照不出来)。
 *
 * 现在:文件流迟到期间先在内存里攒(有上限),目录一到就把攒下的补写进去 —— 启动崩溃恰恰爱发生在这一段。
 * 落盘彻底没戏(目录建不出来)→ 转成往 fd 1 直吐,❌ 不静默吞。
 */
const MAX_BUFFER_BYTES = 256 * 1024
class LateFileSink extends Writable {
  private fd: number | null = null
  private path: string | null = null
  private bytes = 0
  private maxBytes = MAX_BYTES
  private buffered: string[] = []
  private bufferedBytes = 0
  private dropped = 0
  private echoToStdout = false

  get attached(): boolean {
    return this.fd !== null
  }

  override _write(chunk: Buffer | string, _enc: unknown, cb: (e?: Error | null) => void): void {
    const line = chunk.toString()
    if (this.fd !== null) this.write2file(line)
    else if (this.echoToStdout) writeStdout(line)
    else if (this.bufferedBytes + line.length <= MAX_BUFFER_BYTES) {
      this.buffered.push(line)
      this.bufferedBytes += line.length
    } else {
      this.dropped += 1
      // ❌ 不能静默丢:没目录时 attach() 永远不跑,那条「丢了 N 行」的告警也就永远不会发出来(review 指出)。
      if (this.dropped === 1) {
        writeSync(2, `[logger] 日志缓冲已满(${MAX_BUFFER_BYTES} 字节)且还没拿到落盘目录 —— 后续行将被丢弃。`
          + `请给 initLogging({dir}) 或设 GUGU_LOG_DIR。\n`)
      }
    }
    cb()
  }

  /**
   * 落盘用**同步** `writeSync(fd)`,❌ 不用 createWriteStream。
   * 实测踩过:WriteStream 的 open 是异步的,一串日志同步刷完时磁盘上文件还没建 → 轮转的 `renameSync`
   * 报 ENOENT(被 catch 吞掉)、轮转形同没做。fd + writeSync 让"写了多少 / 现在轮转"变成确定的事。
   * 量级也撑得住:主进程日志是人和 agent 的事件速率,一行几百字节写进 page cache 是微秒级。
   *
   * 运行期也守上限:app 常开好几天,一个爱说话的 agent 循环能把单文件写到几个 G ——
   * 只在启动时轮转,「5MB 轮转」就是句假话,最后是用户的磁盘替我们兜。
   */
  private write2file(line: string): void {
    if (this.fd === null) return
    try {
      writeSync(this.fd, line)
    } catch {
      return // 盘满/fd 坏:❌ 不能把调用方拖崩
    }
    this.bytes += Buffer.byteLength(line)
    if (this.bytes < this.maxBytes || !this.path) return
    const path = this.path
    try {
      closeSync(this.fd)
      rotateNow(path)
      this.fd = openSync(path, 'a')
      this.bytes = 0
    } catch {
      this.fd = null // 轮转塌了 → 当作落盘没戏,而不是继续写一个越来越大的文件
      logFilePath = null
      this.giveUp(true)
    }
  }

  /** 目录到位:接上真文件,并把等待期间攒的行补写进去。 */
  attach(fd: number, path: string, maxBytes = MAX_BYTES): void {
    this.fd = fd
    this.path = path
    this.maxBytes = maxBytes
    this.bytes = fileSize(path)
    const pending = this.buffered
    const dropped = this.dropped
    this.reset()
    for (const line of pending) this.write2file(line)
    if (dropped) {
      this.write2file(`${JSON.stringify({
        level: 40, time: Date.now(), scope: 'logger',
        msg: `日志目录到位前缓冲已满,丢了 ${dropped} 行(上限 ${MAX_BUFFER_BYTES} 字节)`,
      })}\n`)
    }
  }

  /** #4277 换目标文件(按账号分文件):关旧、接新。攒下的行此时为空,attach 的补写逻辑照走无害。 */
  reattach(fd: number, path: string, maxBytes = MAX_BYTES): void {
    this.closeFile()
    this.attach(fd, path, maxBytes)
  }

  /** 单测/退出用:关掉当前文件。 */
  closeFile(): void {
    if (this.fd === null) return
    try {
      closeSync(this.fd)
    } catch {
      /* noop */
    }
    this.fd = null
  }

  /** 落盘没戏了:`echo=true` 时把攒下的和后续都往 fd 1 吐(stdout 那路已经有人打就别打两遍)。 */
  giveUp(echo: boolean): void {
    this.echoToStdout = echo
    if (echo) for (const line of this.buffered) writeStdout(line)
    this.reset()
  }

  private reset(): void {
    this.buffered = []
    this.bufferedBytes = 0
    this.dropped = 0
  }
}

let root: PinoLogger | null = null
let sink: LateFileSink | null = null
let logFilePath: string | null = null
/** 落盘根目录(userData/logs);按账号分文件时用户目录挂在它下面。 */
let logBaseDir: string | null = null
let logMaxBytes: number | undefined

/**
 * 有目录就把真文件接到 sink 上(幂等:已接过就不动)。
 * 失败**不抛** —— 只读盘/没权限不该让 app 起不来,但要响亮说明原因,并让日志改走 stdout。
 */
function attachFile(dirOption: string | undefined, echoOnFailure: boolean, maxBytes?: number): void {
  const dir = resolveDir(dirOption)
  if (!sink || sink.attached || !dir) return
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'gugu-main.log')
    if (fileSize(file) >= (maxBytes ?? MAX_BYTES)) rotateNow(file)
    sink.attach(openSync(file, 'a'), file, maxBytes)
    logFilePath = file
    logBaseDir = dir
    logMaxBytes = maxBytes
  } catch (error) {
    sink.giveUp(echoOnFailure)
    root?.warn(
      { dir, err: error instanceof Error ? error.message : String(error) },
      '日志落盘失败,只打 stdout —— 排障时拿不到文件,请检查该目录权限',
    )
  }
}

/**
 * #4277 日志按账号分文件:登录确立后切到 `<logs>/users/<ownerUserId>/gugu-main.log`,退出(null)切回根文件。
 * 启动到登录之间那一段留在根文件 —— 那时还不知道是谁。两边各写一行指路,排障时顺着走。
 * 返回切换后的文件路径;没落盘 / 已在目标文件上 → 原样返回当前路径。失败不抛:日志不该让 app 起不来。
 */
export function switchLogFileForOwner(ownerUserId: string | null): string | null {
  if (!sink || !sink.attached || !logBaseDir) return logFilePath
  const dir = ownerUserId ? join(logBaseDir, 'users', ownerUserId) : logBaseDir
  const file = join(dir, 'gugu-main.log')
  if (file === logFilePath) return logFilePath
  const from = logFilePath
  try {
    mkdirSync(dir, { recursive: true })
    root?.info({ scope: 'logger', to: file }, `#4277 日志切到账号文件:${file}`)
    if (fileSize(file) >= (logMaxBytes ?? MAX_BYTES)) rotateNow(file)
    sink.reattach(openSync(file, 'a'), file, logMaxBytes)
    logFilePath = file
    root?.info({ scope: 'logger', from }, `#4277 日志从 ${from} 接续`)
  } catch (error) {
    root?.warn(
      { dir, err: error instanceof Error ? error.message : String(error) },
      '#4277 按账号切日志文件失败,继续写原文件',
    )
  }
  return logFilePath
}

/** 日志文件在哪(给「反馈」入口/排障提示用);没落盘则 null。 */
export function currentLogFile(): string | null {
  return logFilePath
}

/** 附带进反馈的日志尾巴上限。owner 2026-09-03 拍板:2000 行封顶。 */
export const FEEDBACK_LOG_TAIL_MAX_LINES = 2000
/** 行数之外再压一道字节闸:一行是没有长度上限的(整个 stack、整个 payload 都可能在一行里)。 */
export const FEEDBACK_LOG_TAIL_MAX_BYTES = 512 * 1024

export interface LogTail {
  text: string
  lines: number
  bytes: number
  /** 到顶被裁过 —— 让界面能如实说「最近 N 行」而不是「全部日志」。 */
  truncated: boolean
}

/**
 * 取日志尾巴,供用户在反馈里**自愿**附带(#4899)。
 *
 * ⚠ 这里**再脱敏一遍**,不是多此一举:落盘时的脱敏用的是**写那一刻**的规则表。#4899 之前
 * 的规则漏 GitHub PAT / 私钥块 / 连接串内联密码,所以用户机器上**已经躺着的**旧日志行里
 * 就带着这些明文。只靠写入侧脱敏 = 只保护新行,而反馈上传的恰恰是历史。
 *
 * ❌ 不做兜底静默:文件不在或读不了就 throw,由调用方当场告诉用户「这次带不上日志」——
 * 悄悄附一个空的比不附更坏(用户以为给了线索,排查方以为用户没日志)。
 */
export function readLogTailForFeedback(): LogTail {
  const file = logFilePath
  if (!file) throw new Error('log file is not initialised')
  // 单文件本来就按 maxBytes 轮转(默认 5MB),整读再切比反向扫简单,且不会读到半行。
  const all = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0)
  let kept = all.slice(-FEEDBACK_LOG_TAIL_MAX_LINES).map(redactText)
  let text = kept.join('\n')
  // 字节闸:从**头部**丢(尾巴才是刚发生的事),丢到进闸为止。
  while (kept.length > 0 && Buffer.byteLength(text, 'utf8') > FEEDBACK_LOG_TAIL_MAX_BYTES) {
    kept = kept.slice(Math.max(1, Math.ceil(kept.length * 0.1)))
    text = kept.join('\n')
  }
  return {
    text,
    lines: kept.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    truncated: kept.length < all.length,
  }
}

/**
 * 建根 logger(幂等)。级别:`GUGU_LOG_LEVEL` > dev 用 debug > 默认 info。
 * 落盘失败(只读盘、权限)不该让 app 起不来 —— 退化成只打 stdout,并把原因打出来。
 */
export function initLogging(options: LoggerOptions = {}): PinoLogger {
  // stdout 是运行期开关(见 stdoutEnabled):晚到的调用方也能真正关掉它
  if (options.stdout !== undefined) stdoutEnabled = options.stdout
  // 已经建过根 logger:**不能**就这么早退 —— 真实启动顺序里目录是迟到的(见 LateFileSink)。
  // 这次带了目录就把文件接上;级别也允许后手调整。
  if (root) {
    if (options.level) root.level = options.level
    attachFile(options.dir, !stdoutEnabled, options.maxBytes)
    return root
  }
  // ❌ 不看 NODE_ENV:打包后的 Electron 主进程里它是 **undefined**(vite-plugin-electron 不做静态替换、
  // Electron 也不设),于是生产会一路走成 dev 分支。生产/开发由**调用方**判(main.ts 用 app.isPackaged),
  // 这里只认显式选项与环境变量。
  const level = (options.level ?? (process.env.GUGU_LOG_LEVEL as pino.Level | undefined) ?? 'debug') as pino.Level
  sink = new LateFileSink()
  // ⚠ 每条流都必须显式带 level:pino 的 multistream 对**没写 level 的流**默认 30(info)—— 根 logger 放行了
  // debug,流这一层照样丢掉,整个 debug 档位等于死的(review 实测)。
  const streams: Array<{ level?: pino.Level; stream: NodeJS.WritableStream }> = [
    { level, stream: sink },
    { level, stream: humanStream() },
  ]
  root = pino(
    {
      level,
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.epochTime,
      // 落盘前脱敏(见文件头纪律②)。变参形态 log.info(obj, msg) / log.info(msg) 都要覆盖到。
      hooks: {
        logMethod(args, method) {
          // ❌ 这里不能没有 try:redactValue 走 Object.entries 会触发任意 getter,一个会抛的 getter 就能让
          // `log.error(...)` 抛出去 —— 而它可能正在 uncaughtException 处理器里跑,那样连收引擎进程组的兜底
          // 都不会执行(@@@2125①)。脱敏失败就退化成原样打,❌ 不能把调用方拖崩。
          let safe: unknown[]
          try {
            safe = args.map((a) => (typeof a === 'string' ? redactText(a) : redactValue(a)))
          } catch {
            safe = ['«redact-failed»', ...args.map((a) => (typeof a === 'string' ? a : '«unserializable»'))]
          }
          return method.apply(this, safe as Parameters<typeof method>)
        },
      },
    },
    multistream(streams),
  )
  attachFile(options.dir, !stdoutEnabled, options.maxBytes)
  return root
}

/**
 * 取一个带域名的 logger:`createLogger('sessionpage/deliver')`。
 * 域名就是排障时的过滤键:`jq 'select(.scope|startswith("sessionpage"))' gugu-main.log`。
 */
const loggerByScope = new Map<string, PinoLogger>()
export function createLogger(scope: string): PinoLogger {
  const hit = loggerByScope.get(scope)
  if (hit) return hit
  const made = initLogging().child({ scope })
  loggerByScope.set(scope, made)
  return made
}

/**
 * 把存量 `console.*` 接到日志里。
 *
 * 为什么要这层桥:全仓还有近百处裸 `console.*`,逐个改完才落盘等于短期内一行证据都没有。桥接之后它们**立刻**
 * 进文件、有级别、过脱敏;调用点再按需增量改成结构化的 `createLogger(scope)`。
 * ❌ 不保留原 console 输出:human 流已经打 stdout 了,留着会每行打两遍。
 *
 * scope 按行首 `[域]` 前缀分流(见下方 CONSOLE_SCOPE),没命中的仍是 `console`。
 */
/**
 * 存量 `console.*` 的行首 `[域]` 前缀 → scope。
 *
 * 为什么值得做:实测一次真运行 85 行里 **82 行是 `scope=console`**(#2391)—— 「按 scope 过滤」这个卖点
 * 等于没用。把已有前缀映射成 scope,存量行立刻能按域过滤,比逐个改调用点便宜得多。
 * 保留 `console/` 前缀是诚实:这行仍是桥接来的非结构化文本,不是真正结构化的调用点。
 *
 * ❌ **不剥掉消息里的前缀**:`scripts/appimage-boot-smoke.sh` 的启动断言 grep 的就是 stdout 里的
 * `[sessionpage] boot OK`(那份脚本写着「日志契约…改动须同步」)—— 剥了 CI 当场红。
 */
const CONSOLE_SCOPE: Array<[RegExp, string]> = [
  [/^\[device-runtime\]/, 'device-runtime'],
  [/^\[acp-bridge\]/, 'acp-bridge'],
  [/^\[acp-host\]/, 'acp-host'],
  [/^\[sessionpage/, 'sessionpage'],
  [/^\[main\]/, 'main'],
]

export function consoleScopeFor(first: unknown): string {
  if (typeof first !== 'string') return 'console'
  for (const [re, domain] of CONSOLE_SCOPE) if (re.test(first)) return `console/${domain}`
  return 'console'
}

export function installConsoleBridge(): () => void {
  const byScope = new Map<string, PinoLogger>()
  const scoped = (first: unknown): PinoLogger => {
    const scope = consoleScopeFor(first)
    const hit = byScope.get(scope)
    if (hit) return hit
    const made = createLogger(scope)
    byScope.set(scope, made)
    return made
  }
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
  const forward = (level: 'debug' | 'info' | 'warn' | 'error') => (...args: unknown[]) => {
    const [first, ...rest] = args
    const log = scoped(first)
    // ❌ 别拿 JSON.stringify 取消息:循环引用会**抛** —— 那等于把原本无害的 console.log(循环对象) 变成崩溃。
    // 非字符串首参一律当数据走 args(redactValue 已经能处理循环引用)。
    if (typeof first === 'string') {
      if (rest.length) log[level]({ args: rest }, first)
      else log[level](first)
      return
    }
    log[level]({ args }, '')
  }
  console.log = forward('info')
  console.info = forward('info')
  console.debug = forward('debug')
  console.warn = forward('warn')
  console.error = forward('error')
  return () => Object.assign(console, original)
}

/** renderer 回传的一条日志(经 IPC 通道 `log:write`)。 */
export const RENDERER_LOG_CHANNEL = 'log:write'

/**
 * 收 renderer 回传的日志,落进同一份文件(scope 前缀 `renderer/`,一眼看得出来源)。
 *
 * 纪律:**永不抛**。这是 IPC 端点,渲染进程可能发任何形状的东西;为一条日志把 IPC handler 打挂、
 * 甚至连累调用方,是本末倒置。形状不对就当无效丢弃(计一条 warn),❌ 不 throw。
 * 消息截断 4KB:防止渲染侧误把整份大对象/堆栈刷进日志文件。
 */
export function writeRendererLog(payload: unknown): void {
  try {
    const p = (payload ?? {}) as { scope?: unknown; level?: unknown; msg?: unknown; fields?: unknown }
    const scope = typeof p.scope === 'string' && p.scope.trim() ? p.scope.trim().slice(0, 64) : 'unknown'
    const level = p.level === 'debug' || p.level === 'warn' || p.level === 'error' ? p.level : 'info'
    const msg = typeof p.msg === 'string' ? p.msg.slice(0, 4096) : ''
    const fields = p.fields && typeof p.fields === 'object' ? (p.fields as Record<string, unknown>) : {}
    createLogger(`renderer/${scope}`)[level](fields, msg)
  } catch (error) {
    try {
      createLogger('renderer').warn({ err: String(error) }, '丢弃一条形状不对的 renderer 日志')
    } catch {
      /* 日志系统自己都不行了就算了,❌ 别把 IPC handler 拖挂 */
    }
  }
}

/** 单测用:丢掉当前根 logger(下次 initLogging 重建)。 */
export function resetLoggingForTests(): void {
  logBaseDir = null
  logMaxBytes = undefined
  sink?.closeFile()
  root = null
  sink = null
  logFilePath = null
  loggerByScope.clear()
}
