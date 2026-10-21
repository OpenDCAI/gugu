/**
 * 系统(system.* 5 个:系统 / 已装 App / shell 环境 / 当前用户 / 用户列表)与终端与自动化(script.jxa / script.shell / sdef.get)。
 * 「系统」只读本机的公开信息,不碰系统授权,一点就连上;❌ 序列号、硬件 UUID 这类能认出这台机器的标识。
 * 「终端与自动化」能跑任意代码:每次都先问人(confirm = always),问的那句带脚本开头,人看得见要跑什么。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEVICE_ACTION_CONFIRMED_ARG } from '@gugu/core/shared/deviceActions'
import { bad, bool, clampInt, fail, MAC_PRIVACY, num, ok, str, type ActionFamily, type ActionRunContext, type Args } from '../catalog'
import type { ExecResult } from '../mac-scripts'
import { expandHome, resolveInsideRoots } from '../paths'

/** stdout / stderr 各留 64 KB。 */
const OUTPUT_CAP = 65_536
const SCRIPT_MAX_TIMEOUT_MS = 280_000
const SCRIPT_DEFAULT_TIMEOUT_MS = 30_000
const SDEF_XML_CAP = 200_000

export interface SystemFamilyOptions {
  /** system.apps.list 扫哪些文件夹(测试替换);缺省 /Applications、/System/Applications、~/Applications。 */
  appDirs?(home: string): string[]
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function localIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
}

const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10

function capText(text: string, max = OUTPUT_CAP): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false }
}

/** 跑一个必须成功的系统命令;退出码不是 0 就抛(→ execution_failed,带命令的原话)。 */
async function must(ctx: ActionRunContext, file: string, args: readonly string[], timeoutMs = 15_000): Promise<string> {
  const r = await ctx.deps.exec(file, args, { signal: ctx.signal, timeoutMs })
  if (r.code !== 0) throw new Error(`${path.basename(file)} ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`)
  return r.stdout
}

/** 可以没有的信息(电脑名、语言……):命令失败就是没有。 */
async function maybe(ctx: ActionRunContext, file: string, args: readonly string[]): Promise<string | null> {
  const r = await ctx.deps.exec(file, args, { signal: ctx.signal, timeoutMs: 15_000 })
  const out = r.stdout.trim()
  return r.code === 0 && out ? out : null
}

/** `id` 的输出:uid=501(apple) gid=20(staff) groups=20(staff),12(everyone),… */
function parseId(text: string): { uid: number; gid: number; username: string; groups: string[] } {
  const uid = /uid=(\d+)\(([^)]*)\)/.exec(text)
  const gid = /gid=(\d+)/.exec(text)
  const groupsPart = /groups=(.*)$/m.exec(text)?.[1] ?? ''
  const groups = [...groupsPart.matchAll(/\d+\(([^)]*)\)/g)].map((m) => m[1]!)
  if (!uid || !gid) throw new Error(`id printed something unexpected: ${text.trim().slice(0, 200)}`)
  return { uid: Number(uid[1]), gid: Number(gid[1]), username: uid[2]!, groups }
}

/** `dscl . -list /Users <Key>` 的每行「名字  值」;以空白开头的是上一行的续行,不要。 */
function dsclColumn(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (!line || /^\s/.test(line)) continue
    const m = /^(\S+)\s+(.*)$/.exec(line)
    if (m) map.set(m[1]!, m[2]!.trim())
  }
  return map
}

// ───────────────────────── Info.plist ─────────────────────────

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** 读 Info.plist 里的几个字符串键。文本格式直接读;二进制格式请 plutil 转成文本再读(❌ 转 JSON:带日期 / 数据的 plist 转不了)。 */
async function plistStrings(ctx: ActionRunContext, file: string, keys: readonly string[]): Promise<Record<string, string>> {
  let raw: Buffer
  try {
    raw = await fsp.readFile(file)
  } catch {
    return {}
  }
  let xml = raw.toString('utf8')
  if (raw.subarray(0, 6).toString('latin1') === 'bplist') {
    const r = await ctx.deps.exec('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', file], { signal: ctx.signal, timeoutMs: 15_000 })
    if (r.code !== 0) return {}
    xml = r.stdout
  }
  const out: Record<string, string> = {}
  for (const key of keys) {
    const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)
    if (m) out[key] = decodeXml(m[1]!)
  }
  return out
}

/** 一个文件夹里的 .app(不进 .app 里面;普通文件夹往下再看 depth 层,如 /Applications/Utilities)。 */
async function findApps(dir: string, depth: number): Promise<string[]> {
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.name.endsWith('.app')) found.push(full)
    else if (depth > 0 && e.isDirectory() && !e.name.startsWith('.')) found.push(...await findApps(full, depth - 1))
  }
  return found
}

// ───────────────────────── 脚本 ─────────────────────────

/** 脚本里调 `screencapture` 一律不跑(会以咕咕的身份要「屏幕录制」、弹系统框);截屏走 computer.get_window_state / computer.get_desktop_state。 */
const COMMAND_WRAPPERS = new Set(['sudo', 'env', 'exec', 'nohup', 'time', 'command', 'builtin', 'xargs', 'nice', 'caffeinate'])
const COMMAND_SEPARATOR = /\$\(|[\n;|&(){}`"']/
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

export function invokesScreenCapture(script: string): boolean {
  for (const segment of script.split(COMMAND_SEPARATOR)) {
    const words = segment.trim().split(/\s+/).filter(Boolean)
    // 跳过 sudo / env / nice 这类前缀、它们的选项与数值(nice -n 5)、VAR=值。
    const command = words.find((w) => !(COMMAND_WRAPPERS.has(w) || w.startsWith('-') || /^\d+$/.test(w) || ENV_ASSIGNMENT.test(w)))
    if (command === 'screencapture' || command?.endsWith('/screencapture')) return true
  }
  return false
}

const SCREENCAPTURE_REFUSED = 'screencapture is not allowed in scripts here (it would make macOS ask for Screen Recording on the person\'s screen). Use computer.get_window_state (or screen.get) to look at the screen instead.'

const preview = (script: string) => (script.length > 120 ? `${script.slice(0, 120)}…` : script)

function scriptArgsProblem(args: Args): string | null {
  if (!str(args, 'script')) return 'script is required'
  if (invokesScreenCapture(String(args.script))) return SCREENCAPTURE_REFUSED
  if (args.args !== undefined && (!Array.isArray(args.args) || args.args.length > 1000 || args.args.some((a) => typeof a !== 'string'))) return 'args must be an array of at most 1000 strings'
  const timeout = num(args, 'timeoutMs')
  if (args.timeoutMs !== undefined && (timeout === undefined || timeout < 1000 || timeout > SCRIPT_MAX_TIMEOUT_MS)) return `timeoutMs must be between 1000 and ${SCRIPT_MAX_TIMEOUT_MS}`
  return null
}

/**
 * 跑脚本,自己掐时间:到点了停下回 timeout(❌ 混成「执行失败」),人取消 / 调用超时照常往上抛。
 */
async function runScript(
  ctx: ActionRunContext,
  file: string,
  argv: readonly string[],
  timeoutMs: number,
  extra: { cwd?: string; env?: Record<string, string> } = {},
): Promise<ExecResult | 'timeout'> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await ctx.deps.exec(file, argv, { ...extra, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted && !ctx.signal.aborted) return 'timeout'
    throw error
  } finally {
    clearTimeout(timer)
    ctx.signal.removeEventListener('abort', onAbort)
  }
}

function scriptOutput(r: ExecResult) {
  const stdout = capText(r.stdout.trimEnd())
  const stderr = capText(r.stderr.trimEnd())
  return {
    exit_code: r.code,
    stdout: stdout.text,
    stderr: stderr.text,
    ...(stdout.truncated ? { stdout_truncated: true } : {}),
    ...(stderr.truncated ? { stderr_truncated: true } : {}),
  }
}

// ───────────────────────── 脚本字典(sdef) ─────────────────────────

const SCRIPTING_DEFINITIONS = '/System/Library/ScriptingDefinitions/'

/**
 * 取 App 的脚本字典:系统自己的 OSACopyScriptingDefinitionFromURL(/usr/bin/sdef 用的也是它,但那个命令要装 Xcode,
 * 一般人的电脑上跑不了)。带 .sdef 的读它(xi:include 原样留着,下面再接);老式 .scriptSuite 的(预览、文本编辑)现合成。
 */
const COPY_SDEF_JXA = `function run(argv) {
  ObjC.import('Carbon')
  const input = JSON.parse(argv[0])
  const ref = Ref()
  const err = $.OSACopyScriptingDefinitionFromURL($.NSURL.fileURLWithPath(input.path), 0, ref)
  if (err !== 0) return JSON.stringify({ error: err })
  const data = ObjC.castRefToObject(ref[0])
  return JSON.stringify({ xml: $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js })
}`
/** resNotFound:这个 App 没有脚本字典。 */
const OSA_NO_DICTIONARY = -192

const appSearchDirs = (home: string) => [
  '/Applications',
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
  '/System/Library/CoreServices',
  '/System/Library/CoreServices/Applications',
  path.join(home, 'Applications'),
]

async function isDir(p: string): Promise<boolean> {
  return fsp.stat(p).then((s) => s.isDirectory(), () => false)
}

async function resolveApp(ctx: ActionRunContext, raw: string): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const home = ctx.deps.homedir()
  const expanded = expandHome(raw, home)
  if (path.isAbsolute(expanded)) {
    const bundle = path.resolve(expanded)
    if (!bundle.endsWith('.app')) return { ok: false, message: `app must be an app name (e.g. "Mail") or the path of a .app bundle: ${raw}` }
    return (await isDir(bundle)) ? { ok: true, path: bundle } : { ok: false, message: `no app at ${raw}` }
  }
  const file = raw.endsWith('.app') ? raw : `${raw}.app`
  if (file.includes('/')) return { ok: false, message: `app must be an app name (e.g. "Mail") or an absolute .app path: ${raw}` }
  for (const dir of appSearchDirs(home)) {
    const candidate = path.join(dir, file)
    if (await isDir(candidate)) return { ok: true, path: candidate }
  }
  // 不在常见位置:问 Spotlight(名字里带引号 / 通配符的不问,免得拼坏查询)。
  if (!/['"\\*]/.test(file)) {
    const r = await ctx.deps.exec('/usr/bin/mdfind', [`kMDItemContentType == 'com.apple.application-bundle' && kMDItemFSName == '${file}'c`], { signal: ctx.signal, timeoutMs: 15_000 })
    const hit = r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()).find(Boolean) : undefined
    if (hit) return { ok: true, path: hit }
  }
  return { ok: false, message: `app not found: ${raw} (use system.apps.list to see installed apps)` }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 把 `<xi:include href="file://localhost/System/Library/ScriptingDefinitions/CocoaStandard.sdef" xpointer="…"/>` 换成那个文件里的内容
 * (只认系统那个目录)。App 的字典里见到的 xpointer 就两种(2026-10 本机 /Applications、/System/Applications 实数):
 *   `/dictionary/suite`                         整个 suite 接进来;
 *   `/dictionary/suite/node()[not(self::command and @name = 'x' …)]`  只接 suite 里面的内容(接进 App 自己的同名 suite),去掉点名的那几个。
 */
async function inlineIncludes(xml: string): Promise<string> {
  const includes = [...xml.matchAll(/<xi:include\b[^>]*?\/>/g)]
  let out = xml
  for (const [tag] of includes) {
    const href = /href="([^"]+)"/.exec(tag)?.[1] ?? ''
    const file = decodeURI(href.replace(/^file:\/\/(localhost)?/, ''))
    if (!file.startsWith(SCRIPTING_DEFINITIONS) || !file.endsWith('.sdef') || file.includes('..')) continue
    const included = await fsp.readFile(file, 'utf8').catch(() => null)
    if (included === null) continue
    const xpointer = decodeXml(/xpointer="([^"]+)"/.exec(tag)?.[1] ?? '')
    const suites = [...included.matchAll(/<suite\b[\s\S]*?<\/suite>/g)].map((m) => m[0])
    let inlined: string
    if (/\/dictionary\/suite\/node\(\)/.test(xpointer)) {
      let inner = suites.map((s) => s.replace(/^<suite\b[^>]*>/, '').replace(/<\/suite>$/, '')).join('\n')
      // not(…) 里点名去掉的:每段 self::<标签> 后面跟着的那几个 @name。
      for (const chunk of xpointer.split('self::').slice(1)) {
        const element = /^([\w-]+)/.exec(chunk)?.[1]
        if (!element) continue
        for (const [, name] of chunk.matchAll(/@name\s*=\s*'([^']+)'/g)) {
          inner = inner.replace(new RegExp(`<${element}\\b[^>]*\\bname="${escapeRe(name!)}"[^>]*?(?:/>|>[\\s\\S]*?</${element}>)`, 'g'), '')
        }
      }
      inlined = inner
    } else {
      const only = /@name\s*=\s*['"]([^'"]+)['"]/.exec(xpointer)?.[1]
      inlined = suites.filter((s) => !only || decodeXml(/\bname="([^"]*)"/.exec(s)?.[1] ?? '') === only).join('\n')
    }
    out = out.replace(tag, () => inlined)
  }
  return out
}

interface Typed { type?: string }
interface CommandOut { name: string; description?: string; direct_parameter?: string; parameters: string[]; result?: string }
interface ClassOut { name: string; description?: string; inherits?: string; plural?: string; properties: string[]; elements: string[]; responds_to: string[] }
interface SuiteOut { name: string; description?: string; commands: CommandOut[]; classes: ClassOut[]; class_extensions: ClassOut[]; enumerations: Array<{ name: string; values: string[] }> }

const shortDesc = (d: string | undefined) => (d ? (d.length > 200 ? `${d.slice(0, 200)}…` : d) : undefined)

/** 脚本字典的摘要:每个 suite 的命令(参数)、类(属性 / 元素)、枚举 —— 写 JXA / AppleScript 时要查的就这些。 */
export function summarizeSdef(xml: string): SuiteOut[] {
  const clean = xml
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
  const suites: SuiteOut[] = []
  let suite: SuiteOut | null = null
  let command: (CommandOut & { _params: Array<{ name: string; optional: boolean } & Typed>; _direct?: Typed; _result?: Typed }) | null = null
  let klass: (ClassOut & { _props: Array<{ name: string; ro: boolean } & Typed> }) | null = null
  let enumeration: { name: string; values: string[] } | null = null
  /** 正在收子元素 <type> 的那一项(property / parameter / direct-parameter / result)。 */
  let typed: Typed | null = null
  const addType = (target: Typed, t: string | undefined, list: boolean) => {
    if (!t) return
    const one = list ? `list of ${t}` : t
    target.type = target.type ? `${target.type} | ${one}` : one
  }
  const finishCommand = () => {
    if (!command) return
    command.parameters = command._params.map((p) => `${p.name}: ${p.type ?? 'any'}${p.optional ? ' (optional)' : ''}`)
    if (command._direct) command.direct_parameter = command._direct.type ?? 'any'
    if (command._result?.type) command.result = command._result.type
    command = null
  }
  const finishClass = () => {
    if (!klass) return
    klass.properties = klass._props.map((p) => `${p.name}: ${p.type ?? 'any'}${p.ro ? ' (read-only)' : ''}`)
    klass = null
  }
  const tagRe = /<(\/?)([A-Za-z][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
  for (const m of clean.matchAll(tagRe)) {
    const [, close, tag, rawAttrs, selfClose] = m as unknown as [string, string, string, string, string]
    if (close) {
      if (tag === 'suite') suite = null
      else if (tag === 'command' || tag === 'event') finishCommand()
      else if (tag === 'class' || tag === 'class-extension' || tag === 'record-type') finishClass()
      else if (tag === 'enumeration') enumeration = null
      else if (tag === 'property' || tag === 'parameter' || tag === 'direct-parameter' || tag === 'result') typed = null
      continue
    }
    const a: Record<string, string> = {}
    for (const [, k, v1, v2] of rawAttrs.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) a[k!] = decodeXml(v1 ?? v2 ?? '')
    const hidden = a.hidden === 'yes'
    const open = !selfClose
    switch (tag) {
      case 'suite':
        suite = { name: a.name ?? '', ...(shortDesc(a.description) ? { description: shortDesc(a.description) } : {}), commands: [], classes: [], class_extensions: [], enumerations: [] }
        if (!hidden) suites.push(suite)
        if (!open) suite = null
        break
      case 'command':
      case 'event':
        finishCommand()
        command = { name: a.name ?? '', ...(shortDesc(a.description) ? { description: shortDesc(a.description) } : {}), parameters: [], _params: [] }
        if (suite && !hidden) suite.commands.push(command)
        if (!open) finishCommand()
        break
      case 'parameter':
      case 'direct-parameter':
      case 'result': {
        if (!command) break
        const item: Typed = {}
        addType(item, a.type, false)
        if (tag === 'parameter' && !hidden) command._params.push(Object.assign(item, { name: a.name ?? '', optional: a.optional === 'yes' }))
        else if (tag === 'direct-parameter') command._direct = Object.assign(item, { optional: a.optional === 'yes' })
        else if (tag === 'result') command._result = item
        if (open) typed = item
        break
      }
      case 'class':
      case 'record-type':
      case 'class-extension': {
        finishClass()
        const name = tag === 'class-extension' ? a.extends ?? '' : a.name ?? ''
        klass = {
          name,
          ...(shortDesc(a.description) ? { description: shortDesc(a.description) } : {}),
          ...(a.inherits ? { inherits: a.inherits } : {}),
          ...(a.plural ? { plural: a.plural } : {}),
          properties: [],
          elements: [],
          responds_to: [],
          _props: [],
        }
        if (suite && !hidden) (tag === 'class-extension' ? suite.class_extensions : suite.classes).push(klass)
        if (!open) finishClass()
        break
      }
      case 'property': {
        if (!klass) break
        const item = { name: a.name ?? '', ro: a.access === 'r' } as { name: string; ro: boolean } & Typed
        addType(item, a.type, false)
        if (!hidden) klass._props.push(item)
        if (open) typed = item
        break
      }
      case 'element':
        if (klass && !hidden && a.type) klass.elements.push(a.type)
        break
      case 'responds-to':
        if (klass && !hidden && (a.command ?? a.name)) klass.responds_to.push((a.command ?? a.name)!)
        break
      case 'enumeration':
        enumeration = { name: a.name ?? '', values: [] }
        if (suite && !hidden) suite.enumerations.push(enumeration)
        if (!open) enumeration = null
        break
      case 'enumerator':
        if (enumeration && !hidden && a.name) enumeration.values.push(a.name)
        break
      case 'type':
        if (typed) addType(typed, a.type, a.list === 'yes')
        break
    }
  }
  finishCommand()
  finishClass()
  // 去掉内部记账字段与空数组,结果紧凑一点。
  return JSON.parse(JSON.stringify(suites, (key, value: unknown) => {
    if (key.startsWith('_')) return undefined
    if (Array.isArray(value) && value.length === 0 && key) return undefined
    return value
  })) as SuiteOut[]
}

// ───────────────────────── 动作族 ─────────────────────────

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false }

export function createSystemFamily(options: SystemFamilyOptions = {}): ActionFamily {
  const appDirs = options.appDirs ?? ((home: string) => ['/Applications', '/System/Applications', path.join(home, 'Applications')])

  return {
    groups: [
      { id: 'system', platforms: ['darwin'], iconApp: '/System/Applications/System Settings.app' },
      {
        id: 'shell',
        platforms: ['darwin'],
        iconApp: '/System/Applications/Utilities/Terminal.app',
        settingsUrl: MAC_PRIVACY('Privacy_Automation'),
        osPermission: '系统设置 → 隐私与安全性 → 自动化 → 咕咕 → 打开脚本要控制的 App',
      },
    ],
    actions: [
      {
        name: 'system.get',
        group: 'system',
        title: '查看系统信息',
        titleEn: 'System info',
        description: 'Get this Mac\'s system information: macOS version and build, model identifier, chip, CPU cores, memory, disk space of the home volume, boot time and uptime, host and computer name. detailed: true adds the full hardware / software overview from System Information (slower, ~1 s). Serial number and hardware UUIDs are never included.',
        risk: 'low',
        confirm: 'never',
        input_schema: { type: 'object', properties: { detailed: { type: 'boolean', description: 'Add the System Information hardware / software overview (slower)' } }, additionalProperties: false },
        async run(args, ctx) {
          const home = ctx.deps.homedir()
          const [swVers, sysctl, computerName, df] = await Promise.all([
            must(ctx, '/usr/bin/sw_vers', []),
            must(ctx, '/usr/sbin/sysctl', ['-n', 'hw.model', 'machdep.cpu.brand_string', 'hw.memsize', 'kern.boottime']),
            maybe(ctx, '/usr/sbin/scutil', ['--get', 'ComputerName']),
            must(ctx, '/bin/df', ['-k', home]),
          ])
          const vers = new Map(swVers.split('\n').map((l) => /^(\w+):\s*(.*)$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1]!, m[2]!.trim()]))
          const [model = '', chip = '', memsize = '', boottime = ''] = sysctl.split('\n').map((l) => l.trim())
          const bootSec = Number(/sec\s*=\s*(\d+)/.exec(boottime)?.[1])
          const dfLine = df.trim().split('\n')[1] ?? ''
          const dfm = /\s(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s.*?(\/\S*(?: \S+)*)\s*$/.exec(dfLine)
          const now = ctx.deps.now()
          const data: Record<string, unknown> = {
            os: { name: vers.get('ProductName') ?? 'macOS', version: vers.get('ProductVersion') ?? null, build: vers.get('BuildVersion') ?? null },
            computer_name: computerName,
            hostname: os.hostname(),
            model_identifier: model || null,
            chip: chip || null,
            arch: os.arch(),
            cpu_cores: os.cpus().length,
            memory_gb: Number(memsize) > 0 ? gb(Number(memsize)) : null,
            disk: dfm
              ? { volume: dfm[5], total_gb: gb(Number(dfm[1]) * 1024), available_gb: gb(Number(dfm[3]) * 1024), used_percent: Number(dfm[4]) }
              : null,
            ...(Number.isFinite(bootSec)
              ? { boot_time: localIso(new Date(bootSec * 1000)), uptime_seconds: Math.max(0, Math.round(now.getTime() / 1000 - bootSec)) }
              : {}),
          }
          if (bool(args, 'detailed')) {
            const raw = await must(ctx, '/usr/sbin/system_profiler', ['SPHardwareDataType', 'SPSoftwareDataType', '-json'], 60_000)
            const parsed = JSON.parse(raw) as { SPHardwareDataType?: unknown[]; SPSoftwareDataType?: unknown[] }
            // ❌ 能认出这台机器的标识(序列号、硬件 UUID、配置 UDID……)。
            const scrub = (v: unknown) => Object.fromEntries(Object.entries(isRecord(v) ? v : {}).filter(([k]) => k !== '_name' && !/serial|uuid|udid/i.test(k)))
            data.hardware = scrub(parsed.SPHardwareDataType?.[0])
            data.software = scrub(parsed.SPSoftwareDataType?.[0])
          }
          return ok(data)
        },
      },
      {
        name: 'system.apps.list',
        group: 'system',
        title: '列出已装 App',
        titleEn: 'List installed apps',
        description: 'List apps installed in /Applications, /System/Applications and ~/Applications (one folder level deep, e.g. Utilities): name, bundle id, version, path, sorted by name. search filters by name or bundle id (case-insensitive substring). limit defaults to 50 (max 500); total is the number of matches.',
        risk: 'low',
        confirm: 'never',
        input_schema: {
          type: 'object',
          properties: {
            search: { type: 'string', description: 'Case-insensitive substring of the app name or bundle id' },
            limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max apps to return (default 50)' },
          },
          additionalProperties: false,
        },
        async run(args, ctx) {
          const dirs = appDirs(ctx.deps.homedir())
          const paths = (await Promise.all(dirs.map((d) => findApps(d, 1)))).flat()
          const apps = await Promise.all(paths.map(async (p) => {
            const keys = await plistStrings(ctx, path.join(p, 'Contents', 'Info.plist'), ['CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleVersion'])
            return {
              name: path.basename(p, '.app'),
              bundle_id: keys.CFBundleIdentifier ?? null,
              version: keys.CFBundleShortVersionString ?? keys.CFBundleVersion ?? null,
              path: p,
            }
          }))
          const search = str(args, 'search').toLowerCase()
          const hits = apps
            .filter((a) => !search || a.name.toLowerCase().includes(search) || (a.bundle_id ?? '').toLowerCase().includes(search))
            .sort((a, b) => a.name.localeCompare(b.name))
          const limit = clampInt(num(args, 'limit'), 50, 1, 500)
          return ok({ total: hits.length, apps: hits.slice(0, limit), ...(hits.length > limit ? { truncated: true } : {}) })
        },
      },
      {
        name: 'system.shell.get',
        group: 'system',
        title: '查看 shell 环境',
        titleEn: 'Shell environment',
        description: 'Get the shell environment script.shell runs in: the person\'s default login shell and its version, shells listed in /etc/shells, PATH and common variables (HOME, LANG, EDITOR …), Homebrew prefix, and the user id / groups (from `id`). Note: PATH is 咕咕\'s own environment; script.shell starts a non-login, non-interactive shell, so ~/.zshrc additions (nvm, pyenv …) are missing unless the script sources them.',
        risk: 'low',
        confirm: 'never',
        input_schema: EMPTY_SCHEMA,
        async run(_args, ctx) {
          const shell = os.userInfo().shell || process.env.SHELL || '/bin/zsh'
          const base = path.basename(shell)
          const [idOut, shellsText, version] = await Promise.all([
            must(ctx, '/usr/bin/id', []),
            fsp.readFile('/etc/shells', 'utf8').catch(() => ''),
            ['zsh', 'bash', 'fish'].includes(base) ? maybe(ctx, shell, ['--version']) : Promise.resolve(null),
          ])
          const id = parseId(idOut)
          const shells = shellsText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
          const env: Record<string, string | null> = {}
          for (const k of ['HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'EDITOR', 'VISUAL', 'TMPDIR']) env[k] = process.env[k] ?? null
          return ok({
            default_shell: shell,
            default_shell_version: version?.split('\n')[0] ?? null,
            shells: shells.map((p) => ({ path: p, available: fs.existsSync(p) })),
            path: process.env.PATH ?? null,
            env,
            homebrew_prefix: ['/opt/homebrew', '/usr/local'].find((p) => fs.existsSync(path.join(p, 'bin', 'brew'))) ?? null,
            user: id.username,
            uid: id.uid,
            gid: id.gid,
            groups: id.groups,
          })
        },
      },
      {
        name: 'system.user.get',
        group: 'system',
        title: '查看当前用户',
        titleEn: 'Current user',
        description: 'Get the logged-in user of this Mac: username, full name, uid / gid, home folder, login shell, whether they are an administrator, their groups, locale and preferred languages, and the time zone (IANA name and UTC offset).',
        risk: 'low',
        confirm: 'never',
        input_schema: EMPTY_SCHEMA,
        async run(_args, ctx) {
          const [idOut, fullName, locale, languages] = await Promise.all([
            must(ctx, '/usr/bin/id', []),
            maybe(ctx, '/usr/bin/id', ['-F']),
            maybe(ctx, '/usr/bin/defaults', ['read', '-g', 'AppleLocale']),
            maybe(ctx, '/usr/bin/defaults', ['read', '-g', 'AppleLanguages']),
          ])
          const id = parseId(idOut)
          const now = ctx.deps.now()
          return ok({
            username: id.username,
            full_name: fullName,
            uid: id.uid,
            gid: id.gid,
            home: ctx.deps.homedir(),
            shell: os.userInfo().shell || null,
            is_admin: id.groups.includes('admin'),
            groups: id.groups,
            locale,
            languages: languages ? [...languages.matchAll(/"([^"]+)"|^\s*([\w-]+),?\s*$/gm)].map((m) => (m[1] ?? m[2])!).filter(Boolean) : [],
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            utc_offset: localIso(now).slice(-6),
          })
        },
      },
      {
        name: 'system.users.list',
        group: 'system',
        title: '列出用户',
        titleEn: 'List users',
        description: 'List the user accounts on this Mac: username, full name, uid, home folder, shell, whether admin, whether currently logged in, and which one is the current user, sorted by uid. System / service accounts (names starting with _, uid < 500, root, daemon, nobody) are left out unless includeSystem is true.',
        risk: 'low',
        confirm: 'never',
        input_schema: {
          type: 'object',
          properties: { includeSystem: { type: 'boolean', description: 'Also list system / service accounts (default false)' } },
          additionalProperties: false,
        },
        async run(args, ctx) {
          const dscl = (key: string) => must(ctx, '/usr/bin/dscl', ['.', '-list', '/Users', key])
          const [uids, names, homes, shells, admins, who] = await Promise.all([
            dscl('UniqueID'),
            dscl('RealName'),
            dscl('NFSHomeDirectory'),
            dscl('UserShell'),
            maybe(ctx, '/usr/bin/dscl', ['.', '-read', '/Groups/admin', 'GroupMembership']),
            maybe(ctx, '/usr/bin/who', []),
          ])
          const realNames = dsclColumn(names)
          const homeDirs = dsclColumn(homes)
          const userShells = dsclColumn(shells)
          const adminSet = new Set((admins ?? '').replace(/^GroupMembership:/, '').trim().split(/\s+/).filter(Boolean))
          const loggedIn = new Set((who ?? '').split('\n').map((l) => l.split(/\s+/)[0]).filter(Boolean))
          const current = os.userInfo().username
          const includeSystem = bool(args, 'includeSystem') === true
          const users = [...dsclColumn(uids)]
            .map(([username, uid]) => ({ username, uid: Number(uid) }))
            .filter((u) => Number.isFinite(u.uid))
            .filter((u) => includeSystem || !(u.username.startsWith('_') || u.uid < 500 || ['root', 'daemon', 'nobody'].includes(u.username)))
            .sort((a, b) => a.uid - b.uid)
            .map((u) => ({
              username: u.username,
              full_name: realNames.get(u.username) ?? null,
              uid: u.uid,
              home: homeDirs.get(u.username) ?? null,
              shell: userShells.get(u.username) ?? null,
              is_admin: adminSet.has(u.username),
              logged_in: loggedIn.has(u.username),
              is_current: u.username === current,
            }))
          return ok({ total: users.length, users })
        },
      },
      {
        name: 'script.jxa',
        group: 'shell',
        title: '运行 JXA / AppleScript',
        titleEn: 'Run JXA / AppleScript',
        description: 'Run a JXA (JavaScript for Automation, default) or AppleScript snippet with osascript on this Mac and return its stdout (the value of the last expression / `run` return), stderr and exit code (64 KB each). args are passed to `run(argv)`. Prefer the dedicated actions (calendar.*, reminders.*, notes.*, mail.*, contacts.*, messages.*) and fall back to scripts only when none covers the task; use sdef.get to look up an app\'s scripting dictionary first. The first time a script controls an app, macOS asks the person to allow it. Scripts calling `screencapture` are refused (use computer.get_window_state). Runs arbitrary code, so every run must be confirmed by the person: without confirmed: true it returns needs_confirmation. timeoutMs defaults to 30000 (max 280000); set the call\'s timeout_ms above it.',
        risk: 'high',
        confirm: 'always',
        input_schema: {
          type: 'object',
          required: ['script'],
          properties: {
            script: { type: 'string', description: 'The JXA or AppleScript source' },
            language: { type: 'string', enum: ['javascript', 'applescript'], description: 'Default javascript (JXA)' },
            args: { type: 'array', items: { type: 'string' }, maxItems: 1000, description: 'Arguments for run(argv)' },
            timeoutMs: { type: 'integer', minimum: 1000, maximum: SCRIPT_MAX_TIMEOUT_MS, description: `Default ${SCRIPT_DEFAULT_TIMEOUT_MS}` },
            [DEVICE_ACTION_CONFIRMED_ARG]: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        validate(args) {
          if (args.language !== undefined && args.language !== 'javascript' && args.language !== 'applescript') return 'language must be "javascript" or "applescript"'
          return scriptArgsProblem(args)
        },
        question: (args) => `要在这台电脑上运行这段 ${args.language === 'applescript' ? 'AppleScript' : 'JXA'} 脚本吗？\n${preview(str(args, 'script'))}`,
        async run(args, ctx) {
          const script = String(args.script)
          const language = args.language === 'applescript' ? 'AppleScript' : 'JavaScript'
          const timeoutMs = clampInt(num(args, 'timeoutMs'), SCRIPT_DEFAULT_TIMEOUT_MS, 1000, SCRIPT_MAX_TIMEOUT_MS)
          const argv = Array.isArray(args.args) ? (args.args as string[]) : []
          ctx.note('正在运行脚本…')
          const r = await runScript(ctx, '/usr/bin/osascript', ['-l', language, '-e', script, '--', ...argv], timeoutMs)
          if (r === 'timeout') return fail('timeout', `The script did not finish within ${timeoutMs / 1000} s and was stopped. Raise timeoutMs (max ${SCRIPT_MAX_TIMEOUT_MS}) or make it do less.`)
          // 被 macOS 拦下的 Apple Event:说清去哪打开。❌ 回 os_permission —— 那只是这一个目标 App 没允许,不该把整组标成没授权。
          if (r.code !== 0 && /-1743|Not authori[sz]ed to send Apple events/i.test(r.stderr)) {
            const app = /Apple events to (.+?)\.?\s*\(-1743\)/i.exec(r.stderr)?.[1] ?? 'the app the script controls'
            return fail('execution_failed', `macOS has not allowed 咕咕 to control ${app}: the person can turn it on in System Settings → Privacy & Security → Automation → 咕咕 → ${app}, then retry.`)
          }
          if (r.code !== 0 && /-1712|AppleEvent timed out/i.test(r.stderr)) {
            return fail('execution_failed', 'The app the script controls did not answer: macOS is most likely asking on this computer whether 咕咕 may control it. The person should click "Allow" there, then retry.')
          }
          return ok(scriptOutput(r))
        },
      },
      {
        name: 'script.shell',
        group: 'shell',
        title: '运行 shell 脚本',
        titleEn: 'Run shell script',
        description: 'Run a shell script on this Mac (`<shell> -c script`, zsh by default; bash / sh also available) and return stdout, stderr (64 KB each) and the exit code — a non-zero exit is still a normal result. args become $1, $2 …; env adds variables; cwd must be inside a connected file location (default: home folder). It is a non-login, non-interactive shell with 咕咕\'s PATH (see system.shell.get): ~/.zshrc is not read, so source it in the script if you need Homebrew / nvm paths. `screencapture` is refused (use computer.get_window_state). Runs arbitrary code, so every run must be confirmed by the person: without confirmed: true it returns needs_confirmation. timeoutMs defaults to 30000 (max 280000); set the call\'s timeout_ms above it.',
        risk: 'high',
        confirm: 'always',
        input_schema: {
          type: 'object',
          required: ['script'],
          properties: {
            script: { type: 'string', description: 'Shell script source' },
            shell: { type: 'string', enum: ['zsh', 'bash', 'sh'], description: 'Default zsh' },
            args: { type: 'array', items: { type: 'string' }, maxItems: 1000, description: 'Positional arguments ($1, $2 …)' },
            cwd: { type: 'string', description: 'Working folder (absolute or ~/…), inside a connected file location; default the home folder' },
            env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables' },
            timeoutMs: { type: 'integer', minimum: 1000, maximum: SCRIPT_MAX_TIMEOUT_MS, description: `Default ${SCRIPT_DEFAULT_TIMEOUT_MS}` },
            [DEVICE_ACTION_CONFIRMED_ARG]: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        validate(args) {
          if (args.shell !== undefined && !['zsh', 'bash', 'sh'].includes(String(args.shell))) return 'shell must be zsh, bash or sh'
          if (args.cwd !== undefined && !str(args, 'cwd')) return 'cwd must be a non-empty path'
          if (args.env !== undefined) {
            if (!isRecord(args.env)) return 'env must be an object of strings'
            for (const [k, v] of Object.entries(args.env)) {
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return `env: invalid variable name ${k}`
              if (typeof v !== 'string') return `env.${k} must be a string`
            }
          }
          return scriptArgsProblem(args)
        },
        question: (args) => `要在这台电脑上运行这段 ${str(args, 'shell') || 'zsh'} 脚本吗？${str(args, 'cwd') ? `（在 ${str(args, 'cwd')} 里）` : ''}\n${preview(str(args, 'script'))}`,
        async run(args, ctx) {
          const shell = (['zsh', 'bash', 'sh'] as const).find((s) => s === args.shell) ?? 'zsh'
          let cwd = ctx.deps.homedir()
          if (str(args, 'cwd')) {
            const resolved = await resolveInsideRoots(str(args, 'cwd'), ctx.granted())
            if (!resolved.ok) return bad(`cwd: ${resolved.message}`)
            if (!(await isDir(resolved.path))) return bad(`cwd is not a folder: ${str(args, 'cwd')}`)
            cwd = resolved.path
          }
          const timeoutMs = clampInt(num(args, 'timeoutMs'), SCRIPT_DEFAULT_TIMEOUT_MS, 1000, SCRIPT_MAX_TIMEOUT_MS)
          const argv = Array.isArray(args.args) ? (args.args as string[]) : []
          ctx.note('正在运行脚本…')
          const r = await runScript(ctx, `/bin/${shell}`, ['-c', String(args.script), shell, ...argv], timeoutMs, {
            cwd,
            ...(isRecord(args.env) ? { env: args.env as Record<string, string> } : {}),
          })
          if (r === 'timeout') return fail('timeout', `The script did not finish within ${timeoutMs / 1000} s and was stopped. Raise timeoutMs (max ${SCRIPT_MAX_TIMEOUT_MS}) or make it do less.`)
          return ok({ cwd, ...scriptOutput(r) })
        },
      },
      {
        name: 'sdef.get',
        group: 'shell',
        title: '查看 App 脚本字典',
        titleEn: 'App scripting dictionary',
        description: 'Read the scripting dictionary (SDEF) of a Mac app — what JXA / AppleScript can do with it. app is an app name ("Mail", "Safari") or the absolute path of a .app bundle. format "summary" (default) lists each suite\'s commands with their parameters, classes with properties / elements, and enumerations; "xml" returns the SDEF XML (capped at 200 KB). Fails if the app is not scriptable.',
        risk: 'low',
        confirm: 'never',
        input_schema: {
          type: 'object',
          required: ['app'],
          properties: {
            app: { type: 'string', description: 'App name (e.g. "Mail") or absolute .app path' },
            format: { type: 'string', enum: ['summary', 'xml'], description: 'Default summary' },
          },
          additionalProperties: false,
        },
        validate(args) {
          if (!str(args, 'app')) return 'app is required'
          if (args.format !== undefined && args.format !== 'summary' && args.format !== 'xml') return 'format must be "summary" or "xml"'
          return null
        },
        async run(args, ctx) {
          const app = await resolveApp(ctx, str(args, 'app'))
          if (!app.ok) return bad(app.message)
          const name = path.basename(app.path, '.app')
          const r = await ctx.deps.jxa(COPY_SDEF_JXA, { path: app.path }, { signal: ctx.signal, timeoutMs: 60_000, app: name })
          if (isRecord(r) && r.error === OSA_NO_DICTIONARY) return fail('execution_failed', `${name} has no scripting dictionary (it is not AppleScript-scriptable). Drive its interface with computer.* instead.`)
          if (!isRecord(r) || typeof r.xml !== 'string') return fail('execution_failed', `could not read the scripting dictionary of ${name}: ${JSON.stringify(r).slice(0, 200)}`)
          const xml = await inlineIncludes(r.xml)
          if (args.format === 'xml') {
            const capped = capText(xml, SDEF_XML_CAP)
            return ok({ app: name, path: app.path, format: 'xml', content: capped.text, ...(capped.truncated ? { truncated: true } : {}) })
          }
          return ok({ app: name, path: app.path, format: 'summary', suites: summarizeSdef(xml) })
        },
      },
    ],
  }
}
