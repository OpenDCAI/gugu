/**
 * 电脑控制(computer.*)与屏幕(screen.get / screen.elements.find),引擎是 trycua/cua 的 cua-driver(native/cua-client.ts)。
 *
 * computer.<工具名> 一个对一个转成 cua-driver 的同名 MCP 工具;说明与参数照它自己导出的清单(cua-tools.json,打包时导出),
 * 只去掉 session(咕咕按调用方自己分),再补上咕咕的几条规矩。没有这份清单(开发环境没编)也照样登记,让设置页列得出来,
 * 整组因为 `needs: 'cua'` 不可用并说清为什么。
 *
 * 咕咕在 cua-driver 之上多管四件事(它自己不管):
 * 1. **不碰咕咕自己**:目标是咕咕本身(pid、bundle id、App 名)的一律拒 —— 否则 agent 能自己点开设置给自己加权限。
 * 2. **不动人的真鼠标**:把整个桌面当目标的输入(scope / target = desktop,或不指定窗口的点、输、按键)会挪人的真鼠标、
 *    落到人正在用的窗口上 —— 拒;只动 agent 自己画的那个鼠标(move_cursor 不带目标)照常。
 * 3. **抢焦点前先问**:delivery_mode = foreground / foreground_fallback 会短暂把目标切到前台,前台 HID 鼠标输入还会移动人的真实指针;
 *    bring_to_front 会把目标一直留在前台,
 *    Windows 上普通启动的 App 可能自己跳到前台(start_minimized 除外),都先回 needs_confirmation。
 * 4. **人随时接管那个 App**:每个动作先告诉 computerControl 它针对哪个窗口(窗口内的小条:<谁> 正在操作「<App>」 · 停止);
 *    人按停止 ⇒ 这个 App 上在途的动作中断、之后再动它一律拒,直到人点「让它继续」;别的 App 照常。人自己用电脑(连同点进那个 App)不打断它。
 *
 * 浏览器类(page / browser_*)不开:咕咕有自己的浏览器页签;接管人已登录的浏览器在 cua 里也要额外授权。
 * 剪贴板走「剪贴板」组。录制、配置、扩展、更新、会话、agent 鼠标的开关这些维护类工具不给 agent(❌ 让它把自己的鼠标藏起来)。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DeviceActionRisk } from '@gugu/core/shared/deviceActions'
import {
  MAC_PRIVACY,
  clampInt,
  fail,
  num,
  ok,
  requestHelperPermission,
  str,
  type ActionDef,
  type ActionFamily,
  type ActionPicture,
  type ActionRunContext,
  type Args,
  type FamilyContext,
  type Outcome,
  type SelfApp,
} from '../catalog'
import type { DeviceActionPermit } from '@gugu/core/cloud/deviceActionHost'
import type { CuaClient, CuaToolResult } from '../native/cua-client'
import { cursorOnWindow } from '../native/cua-window-cursor'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** 一段文字最长留多少(get_window_state 的树很长)。 */
const TEXT_CAP = 100_000

const AX_MESSAGE = `This computer has not given 咕咕 Accessibility permission, so it cannot see or operate other apps. The person needs to turn on 咕咕 in System Settings → Privacy & Security → Accessibility (${MAC_PRIVACY('Privacy_Accessibility')}), then connect "电脑控制 / Computer control" again in 咕咕.`
const SCREEN_MESSAGE = `This computer has not given 咕咕 Screen Recording permission, so it cannot take screenshots (the accessibility tree still works: pass include_screenshot: false). The person needs to turn on 咕咕 in System Settings → Privacy & Security → Screen Recording (${MAC_PRIVACY('Privacy_ScreenCapture')}), then connect "电脑控制 / Computer control" again in 咕咕.`
const BACKGROUND = 'By default, runs in the background: it does not move the person\'s real pointer or take keyboard focus; an agent cursor drawn on screen shows where it acts.'

type Kind = 'look' | 'act'

interface CuaTool {
  /** cua-driver 的工具名;咕咕的名字是 computer.<它>。 */
  cua: string
  title: string
  titleEn: string
  kind: Kind
  /** 默认 look = medium、act = high。 */
  risk?: DeviceActionRisk
  /** always:每次先问;on_conflict:前台投递时先问(动作自己回 needs_confirmation)。 */
  confirm?: 'always' | 'on_conflict'
  question?(args: Args): string
  /** 接在 cua 自己的说明后面的那句。 */
  note?: string
  /** 输入类:目标必须是一个窗口(pid / window target / element_token)。 */
  windowInput?: true
  timeoutMs?(args: Args): number
}

const WINDOW_ONLY = 'Target one window (pid with window_id, a window target, or an element_token from computer.get_window_state). Desktop-wide input (scope or target "desktop", or no window at all) moves the person\'s real pointer and is refused by 咕咕.'
const FOREGROUND = 'delivery_mode "foreground" briefly brings the target to the front and interrupts the person: 咕咕 asks them first (needs_confirmation, then call again with confirmed: true). Foreground HID mouse input moves the person\'s real pointer, including across displays. The person and agent share the pointer and keyboard focus; simultaneous input can interfere with clicks. Coordinate foreground work with the person; standing authorization does not isolate their concurrent desktop use.'
const NOT_GUGU = 'Operating 咕咕 itself is refused.'
const MENU_FOCUS = 'Some native menus need the app to remain active across calls. A foreground click immediately restores the previous app and can dismiss such a menu. After the person has authorized foreground work, record the previous active app with list_apps, use bring_to_front to keep the target active, read the menu and choose its item, then restore the previous app. Check fresh pixels and list_windows filtered by pid; a successful dispatch alone does not prove that a menu opened.'

const TOOLS: readonly CuaTool[] = [
  // 看
  { cua: 'list_apps', title: '列出 App', titleEn: 'List apps', kind: 'look' },
  { cua: 'list_windows', title: '列出窗口', titleEn: 'List windows', kind: 'look', note: 'Menus and popovers can be separate windows. Filter by pid to include their window layers before concluding that a menu did not open.' },
  { cua: 'get_window_state', title: '看窗口', titleEn: 'Read a window', kind: 'look', note: 'Without Screen Recording permission pass include_screenshot: false to get the accessibility tree alone. On macOS, a post-input screenshot includes observation_stability from bounded pixel/geometry sampling; timeout is inconclusive, so read again before acting.' },
  { cua: 'get_accessibility_tree', title: '看桌面概况', titleEn: 'Desktop overview', kind: 'look' },
  { cua: 'get_desktop_state', title: '截整个屏幕', titleEn: 'Capture the screen', kind: 'look' },
  { cua: 'zoom', title: '放大看一块', titleEn: 'Zoom into a window', kind: 'look' },
  { cua: 'get_screen_size', title: '查屏幕尺寸', titleEn: 'Screen size', kind: 'look', risk: 'low' },
  { cua: 'get_cursor_position', title: '查鼠标位置', titleEn: 'Pointer position', kind: 'look', risk: 'low' },
  { cua: 'verify_state', title: '核对窗口状态', titleEn: 'Verify a window', kind: 'look' },
  // App 与窗口
  {
    cua: 'launch_app',
    title: '在后台打开 App',
    titleEn: 'Launch an app',
    kind: 'act',
    risk: 'medium',
    confirm: 'on_conflict',
    note: `On Windows an app may jump to the front as it starts (cua-driver cannot stop that for a normal launch): 咕咕 asks the person first (needs_confirmation, then call again with confirmed: true) — unless you pass start_minimized: true, which starts it without ever activating it, or refuses and starts nothing. Starting an app can take longer than device_call's default 30 s on a busy computer: pass timeout_ms (e.g. 60000). If it still times out, the app may come up anyway — look with list_windows before launching it again. ${NOT_GUGU}`,
  },
  {
    cua: 'bring_to_front',
    title: '把 App 切到前台',
    titleEn: 'Bring an app to front',
    kind: 'act',
    confirm: 'always',
    question: () => '要把它正在操作的 App 切到前台吗？它会一直留在最前面，打断你正在用的窗口。',
    note: `Requires the person's consent; an applicable explicit standing authorization counts. Before activating, record the previous active app with list_apps and restore it after the interactions. ${NOT_GUGU}`,
  },
  { cua: 'set_window_frame', title: '调整窗口位置大小', titleEn: 'Move or resize a window', kind: 'act', risk: 'medium', note: NOT_GUGU },
  { cua: 'invoke_menu', title: '点菜单', titleEn: 'Use an app menu', kind: 'act', note: NOT_GUGU },
  {
    cua: 'kill_app',
    title: '强制退出 App',
    titleEn: 'Force-quit an app',
    kind: 'act',
    confirm: 'always',
    question: (args) => `要强制退出进程 ${num(args, 'pid') ?? '?'} 吗？它没保存的内容会丢。`,
    note: `Only processes this driver launched can be ended; 咕咕 asks the person every time. ${NOT_GUGU}`,
  },
  // 操作
  { cua: 'click', title: '点击', titleEn: 'Click', kind: 'act', confirm: 'on_conflict', windowInput: true, note: MENU_FOCUS },
  { cua: 'double_click', title: '双击', titleEn: 'Double-click', kind: 'act', confirm: 'on_conflict', windowInput: true },
  { cua: 'right_click', title: '右键点击', titleEn: 'Right-click', kind: 'act', confirm: 'on_conflict', windowInput: true },
  { cua: 'drag', title: '拖动', titleEn: 'Drag', kind: 'act', confirm: 'on_conflict', windowInput: true },
  { cua: 'scroll', title: '滚动', titleEn: 'Scroll', kind: 'act', confirm: 'on_conflict', windowInput: true },
  {
    cua: 'move_cursor',
    title: '移动 agent 鼠标',
    titleEn: 'Move the agent cursor',
    kind: 'act',
    risk: 'medium',
    note: 'Without a target only the agent cursor moves (screen points); with a window target it may hover. A desktop target would move the person\'s real pointer and is refused.',
  },
  { cua: 'type_text', title: '输入文字', titleEn: 'Type text', kind: 'act', confirm: 'on_conflict', windowInput: true },
  { cua: 'press_key', title: '按键', titleEn: 'Press a key', kind: 'act', confirm: 'on_conflict', windowInput: true },
  { cua: 'hotkey', title: '按快捷键', titleEn: 'Press a shortcut', kind: 'act', confirm: 'on_conflict', windowInput: true },
  { cua: 'set_value', title: '设置值', titleEn: 'Set a value', kind: 'act', confirm: 'on_conflict', windowInput: true },
  {
    cua: 'run_steps',
    title: '连续做几步',
    titleEn: 'Run steps',
    kind: 'act',
    confirm: 'on_conflict',
    note: 'Every step must name its window (pid, or app — a window title alone is not enough); the same 咕咕 rules apply to each step.',
    timeoutMs: () => 75_000,
  },
]

/** 这些工具带 delivery_mode / target,要按「窗口输入」那套判。 */
const INPUT_TOOLS = new Set(['click', 'double_click', 'right_click', 'drag', 'scroll', 'type_text', 'press_key', 'hotkey', 'set_value', 'move_cursor'])

// ───────────────────────── 工具清单(cua-tools.json) ─────────────────────────

interface CuaSpec { description: string; input_schema: Record<string, unknown> }

export function loadCuaTools(nativeDir: string | null): { specs: Map<string, CuaSpec>; broken: string | null } {
  const specs = new Map<string, CuaSpec>()
  if (!nativeDir) return { specs, broken: null }
  const file = path.join(nativeDir, 'cua-tools.json')
  if (!fs.existsSync(file)) return { specs, broken: null }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { tools?: unknown }
    for (const tool of Array.isArray(parsed.tools) ? parsed.tools : []) {
      if (!isRecord(tool) || typeof tool.name !== 'string') continue
      const schema = isRecord(tool.input_schema) ? tool.input_schema : isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} }
      specs.set(tool.name, { description: typeof tool.description === 'string' ? tool.description : '', input_schema: schema })
    }
    return { specs, broken: null }
  } catch {
    // 读不了就是安装包坏了:人能做的只有重装,解析报错的原话对人没用。
    return { specs, broken: '咕咕带的电脑控制工具清单读不了，请重新安装咕咕' }
  }
}

/** 给 agent 看的参数:cua 的原样,去掉 session(咕咕按调用方分)。 */
function schemaOf(spec: CuaSpec | undefined): Record<string, unknown> {
  if (!spec) return { type: 'object', properties: {}, additionalProperties: true }
  const properties = isRecord(spec.input_schema.properties) ? { ...spec.input_schema.properties } : {}
  delete properties.session
  const required = Array.isArray(spec.input_schema.required) ? spec.input_schema.required.filter((k) => k !== 'session') : undefined
  return { ...spec.input_schema, properties, ...(required ? { required } : {}) }
}

function descriptionOf(t: CuaTool, spec: CuaSpec | undefined): string {
  const own = spec?.description ?? `${t.titleEn} (cua-driver ${t.cua}).`
  const extra = [
    t.kind === 'act' && !['kill_app', 'bring_to_front', 'invoke_menu'].includes(t.cua) ? BACKGROUND : undefined,
    t.windowInput ? WINDOW_ONLY : undefined,
    t.confirm === 'on_conflict' && t.cua !== 'launch_app' ? FOREGROUND : undefined,
    t.note,
  ].filter(Boolean)
  return [own, ...extra].join('\n\n')
}

// ───────────────────────── 规矩:不碰咕咕、不动真鼠标、抢焦点先问 ─────────────────────────

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

function targetPid(args: Args): number | undefined {
  const target = isRecord(args.target) ? args.target : null
  if (target && isNum(target.pid)) return target.pid
  return isNum(args.pid) ? args.pid : undefined
}

function isDesktop(args: Args): boolean {
  const target = isRecord(args.target) ? args.target : null
  return lower(args.scope) === 'desktop' || lower(target?.kind) === 'desktop'
}

/** 一次调用(或 run_steps 里的一步)碰不碰得:回拒绝原因,能做回 null。 */
function refusal(tool: string, args: Args, self: SelfApp, inherited: { pid?: number; app?: string } = {}): string | null {
  const pid = targetPid(args) ?? inherited.pid
  if (pid !== undefined && self.pids.has(pid)) return 'That is 咕咕 itself: 咕咕 does not let an agent operate its own windows. For webpages in this session\'s browser tabs, use browser_* tools.'
  for (const key of ['bundle_id', 'app', 'name'] as const) {
    if (key === 'name' && tool !== 'launch_app' && tool !== 'bring_to_front') continue
    if (self.names.has(lower(args[key]))) return 'That is 咕咕 itself: 咕咕 does not let an agent operate its own windows. For webpages in this session\'s browser tabs, use browser_* tools.'
  }
  if (!INPUT_TOOLS.has(tool)) return null
  if (isDesktop(args)) return 'Desktop-wide input moves the person\'s real pointer / acts on whatever they are using: 咕咕 refuses it. Target one window (pid and window_id, or an element_token).'
  if (tool === 'move_cursor') return null
  const hasWindow = pid !== undefined || typeof args.element_token === 'string' || (inherited.app ?? str(args, 'app')) !== ''
  if (!hasWindow) {
    return typeof args.window === 'string'
      ? 'Name the app too (app or pid): a window title alone could match 咕咕 or a window the person is using.'
      : 'Name the window to act on (pid and window_id, or an element_token from computer.get_window_state): input without a window would land on whatever the person is using.'
  }
  return null
}

function stepsOf(args: Args): Array<{ tool: string; args: Args }> {
  const steps = Array.isArray(args.steps) ? args.steps : []
  return steps.flatMap((step): Array<{ tool: string; args: Args }> => {
    if (!isRecord(step)) return []
    if (typeof step.tool === 'string') return [{ tool: step.tool, args: isRecord(step.args) ? step.args : {} }]
    const key = Object.keys(step).find((k) => INPUT_TOOLS.has(k))
    return key ? [{ tool: key, args: isRecord(step[key]) ? (step[key] as Args) : {} }] : []
  })
}

/** Windows 上普通启动的 App 可能自己跳到前台(cua-driver 拦不住,只有 start_minimized 能保证不激活):先问人。 */
function launchQuestion(args: Args): string {
  const target = str(args, 'name') || path.win32.basename(str(args, 'path') || str(args, 'launch_path')) || str(args, 'bundle_id') || str(args, 'aumid') || '这个 App'
  return `要打开「${target}」吗？在 Windows 上它打开时可能会跳到最前面，打断你正在用的窗口。`
}

/** run_steps 每一步都过一遍;前台投递(自己的或继承的)记下来,回给外面去问。 */
function checkCall(tool: string, args: Args, self: SelfApp, platform: NodeJS.Platform): { refused: string | null; foreground: boolean; question?: string } {
  if (tool === 'launch_app') {
    const refused = refusal(tool, args, self)
    return platform === 'win32' && args.start_minimized !== true
      ? { refused, foreground: true, question: launchQuestion(args) }
      : { refused, foreground: false }
  }
  if (tool !== 'run_steps') {
    return { refused: refusal(tool, args, self), foreground: lower(args.delivery_mode) === 'foreground' }
  }
  const inherited = { ...(isNum(args.pid) ? { pid: args.pid } : {}), ...(typeof args.app === 'string' ? { app: args.app } : {}) }
  if (self.names.has(lower(args.app))) return { refused: 'That is 咕咕 itself: 咕咕 does not let an agent operate its own windows. For webpages in this session\'s browser tabs, use browser_* tools.', foreground: false }
  if (inherited.pid !== undefined && self.pids.has(inherited.pid)) return { refused: 'That is 咕咕 itself: 咕咕 does not let an agent operate its own windows. For webpages in this session\'s browser tabs, use browser_* tools.', foreground: false }
  let foreground = lower(args.delivery_mode) === 'foreground' || args.foreground_fallback === true
  for (const [i, step] of stepsOf(args).entries()) {
    if (!INPUT_TOOLS.has(step.tool)) return { refused: `Step ${i + 1}: run_steps here only runs ${[...INPUT_TOOLS].join(', ')}.`, foreground }
    const problem = refusal(step.tool, step.args, self, inherited)
    if (problem) return { refused: `Step ${i + 1}: ${problem}`, foreground }
    if (lower(step.args.delivery_mode) === 'foreground') foreground = true
  }
  if (isRecord(args.observe) && self.pids.has(targetPid(args.observe) ?? -1)) {
    return { refused: 'That is 咕咕 itself: 咕咕 does not let an agent operate its own windows. For webpages in this session\'s browser tabs, use browser_* tools.', foreground }
  }
  return { refused: null, foreground }
}

// ───────────────────────── 结果 ─────────────────────────

function capStrings(data: Record<string, unknown>): Record<string, unknown> {
  let truncated = false
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' && v.length > TEXT_CAP) {
      out[k] = v.slice(0, TEXT_CAP)
      truncated = true
    } else out[k] = v
  }
  return truncated ? { ...out, truncated: true } : out
}

/**
 * #7317 一张窗口的只读画面,给「电脑」页签看 agent 刚操作的那个窗口:和 agent 自己看窗口(`computer.get_window_state`)
 * 同一道授权,但它不是 agent 的动作 —— ❌ 「正在操作」小条,❌ 进「最近调用」,❌ 动任何 agent 的界面快照(cua `display_only`)。
 */
export async function peekWindow(
  permit: (action: string) => Promise<DeviceActionPermit> | DeviceActionPermit,
  cua: Pick<CuaClient, 'callTool' | 'cursorState'>,
  target: { pid: number; window_id: number },
  options: { maxDimension: number; signal?: AbortSignal; viewer?: string; cursorSession?: string },
  guards: {
    /** 咕咕自己:agent 碰不得的,画面也不取。 */
    self?: () => SelfApp
    /** 人按了停止的 App(或整个电脑控制):停着就不看,原因同 agent 被拒时那一句。 */
    stoppedFor?: (pid: number) => string | null
  } = {},
): Promise<Outcome> {
  const allowed = await permit('computer.get_window_state')
  if (!allowed.ok) return allowed
  if (guards.self?.().pids.has(target.pid)) return fail('invalid_args', 'That window is 咕咕 itself, which the preview does not show.')
  const stopped = guards.stoppedFor?.(target.pid)
  if (stopped) return fail('revoked', stopped)
  let cursorProblem: string | null = null
  const sampleCursor = async () => {
    if (!options.cursorSession || !cua.cursorState) return null
    try {
      const sample = await cua.cursorState(options.cursorSession, options.signal)
      if (sample?.isError) cursorProblem = sample.content?.find(block => block.type === 'text')?.text ?? 'Native cursor read was refused'
      return sample
    } catch (error) { cursorProblem = String(error); return null }
  }
  const before = await sampleCursor()
  const result = await cua.callTool(
    'get_window_state',
    { pid: target.pid, window_id: target.window_id, include_accessibility_tree: false, display_only: true, max_dimension: options.maxDimension },
    // 每个看着的任务一条道(`viewer`):看一眼窗口 ❌ 排在任何 agent 的下一步前面,一个任务的窗口卡住了
    // (cua 的代理一次办一个、取消也收不到)❌ 拖住别的任务的「电脑」页。
    { ...(options.signal ? { signal: options.signal } : {}), timeoutMs: 10_000, lane: options.viewer ? `${PREVIEW_LANE}:${options.viewer}` : PREVIEW_LANE },
  )
  const after = await sampleCursor()
  const outcome = cuaOutcome('computer.get_window_state', result)
  return outcome.ok && options.cursorSession
    ? ok({ ...(isRecord(outcome.data) ? outcome.data : {}), cursor: cursorOnWindow(before, after, result), ...(cursorProblem ? { cursor_problem: cursorProblem } : {}) })
    : outcome
}

/** cua-driver 的结果 → 设备动作的结果:结构化内容进 data,图片进 pictures(❌ base64 进文字)。 */
export function cuaOutcome(name: string, result: CuaToolResult): Outcome {
  const texts: string[] = []
  const pictures: ActionPicture[] = []
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      pictures.push({ label: `${name} screenshot`, mimeType: block.mimeType, data: block.data })
    }
  }
  const text = texts.join('\n')
  const structured = isRecord(result?.structuredContent) ? result.structuredContent : null
  if (result?.isError) {
    const refusalInfo = structured && isRecord(structured.refusal) ? structured.refusal : null
    const message = (typeof refusalInfo?.message === 'string' ? refusalInfo.message : '') || text || 'cua-driver reported an error without details'
    if (/screen recording/i.test(message) && /not (granted|allowed|authorized)|denied|permission/i.test(message)) return fail('os_permission', SCREEN_MESSAGE)
    if (/accessibility/i.test(message) && /not (granted|allowed|trusted|authorized)|denied|permission|disabled/i.test(message)) return fail('os_permission', AX_MESSAGE)
    if (refusalInfo?.code === 'facility_unavailable') return fail('unsupported', `${name}: ${message}`)
    return fail('execution_failed', `${name}: ${message}`)
  }
  const data = structured ?? (text ? { text } : {})
  return ok({ ...capStrings(structured && text && !('summary' in structured) ? { ...data, text } : data), ...(pictures.length ? { pictures } : {}) })
}

/** 「电脑」页签看窗口用的那条道(cua-client 的 lane);和 agent 的会话名(`gugu-<10 位十六进制>`)不会撞。 */
const PREVIEW_LANE = 'gugu-preview'

/** 调用方 → cua 的会话名:各自的界面快照、agent 鼠标互不串。 */
export function sessionOf(ctx: Pick<ActionRunContext, 'caller'>): string {
  const who = ctx.caller?.agent_user_id ?? ctx.caller?.name ?? 'local'
  return `gugu-${createHash('sha256').update(who).digest('hex').slice(0, 10)}`
}

function cuaMissing(ctx: FamilyContext): Outcome | null {
  const r = ctx.deps.cua().available()
  return r.ok ? null : fail('unsupported', r.message)
}

async function callCua(ctx: ActionRunContext, name: string, tool: string, args: Args, timeoutMs = 60_000, signal: AbortSignal | undefined = ctx.signal): Promise<Outcome> {
  // 不带 session 的(列 App、列窗口)也走调用方自己那条道:一个 agent 的调用 ❌ 排在另一个 agent 后面。
  const result = await ctx.deps.cua().callTool(tool, args, { ...(signal ? { signal } : {}), ...(ctx.remainingMs ? { remainingMs: ctx.remainingMs } : {}), timeoutMs, lane: sessionOf(ctx) })
  return cuaOutcome(name, result)
}

// ───────────────────────── 这个动作针对哪个 App(小条上写它的名字,停止只停它) ─────────────────────────

/**
 * pid → App 名、界面快照 → pid,从 cua 回来的结果里记下。element_token(`<快照>:<行>`)本身不带 pid,
 * 靠「这个快照是哪个 App 的」认回来;认不出的动作当作没指定 App(查看这台电脑)。
 *
 * 小条上写人认得的、系统语言的名字,按这个先后取:
 * 1. Windows:exe 版本信息里的 FileDescription(「字符映射表」;cua 在窗口上给的 app_name 只是文件名 charmap.exe);
 * 2. Mac:窗口上的 app_name(「计算器」);
 * 3. 窗口标题;
 * 4. 文件名(charmap.exe);
 * 5. list_apps / launch_app 的 name(Mac 上是包名「Calculator」,Windows 上是英文显示名或路径)。
 */
export function createAppDirectory() {
  const described = new Map<number, string>()
  const windowNames = new Map<number, string>()
  const titles = new Map<number, string>()
  const fileNames = new Map<number, string>()
  const listed = new Map<number, string>()
  const snapshots = new Map<string, { pid: number; windowId?: number }>()
  const askedWindows = new Set<number>()
  const askedDescription = new Set<number>()
  const isFileName = (name: string) => /\.exe$/i.test(name)
  const learnOne = (entry: unknown) => {
    if (!isRecord(entry) || !isNum(entry.pid)) return
    if (typeof entry.app_name === 'string' && entry.app_name) (isFileName(entry.app_name) ? fileNames : windowNames).set(entry.pid, entry.app_name)
    if (typeof entry.title === 'string' && entry.title.trim() && !titles.has(entry.pid)) titles.set(entry.pid, entry.title.trim())
    if (typeof entry.name === 'string' && entry.name && !listed.has(entry.pid)) listed.set(entry.pid, entry.name)
  }
  const once = (asked: Set<number>, pid: number) => {
    if (asked.has(pid)) return false
    asked.add(pid)
    return true
  }
  return {
    pidOf(session: string, args: Args): number | undefined {
      const pid = targetPid(args)
      if (pid !== undefined) return pid
      const token = typeof args.element_token === 'string' ? args.element_token : ''
      const snapshot = token.includes(':') ? token.slice(0, token.lastIndexOf(':')) : ''
      return snapshot ? snapshots.get(`${session}|${snapshot}`)?.pid : undefined
    },
    windowOf(session: string, args: Args): number | undefined {
      const target = isRecord(args.target) ? args.target : args
      if (isNum(target.window_id)) return target.window_id
      const token = typeof args.element_token === 'string' ? args.element_token : ''
      const snapshot = token.includes(':') ? token.slice(0, token.lastIndexOf(':')) : ''
      const known = snapshots.get(`${session}|${snapshot}`)
      return known && (targetPid(args) === undefined || targetPid(args) === known.pid) ? known.windowId : undefined
    },
    nameOf: (pid: number) => described.get(pid) ?? windowNames.get(pid) ?? titles.get(pid) ?? fileNames.get(pid) ?? listed.get(pid),
    /** 还没从窗口上读到过系统语言的名字、也还没问过:该问 cua 一次它的窗口(顺带拿到窗口标题)。 */
    shouldAskWindows: (pid: number) => !described.has(pid) && !windowNames.has(pid) && once(askedWindows, pid),
    /** Windows:还没读过这个进程 exe 的 FileDescription。 */
    shouldAskDescription: (pid: number) => !described.has(pid) && once(askedDescription, pid),
    describe(pid: number, description: string) {
      if (description) described.set(pid, description)
    },
    learn(session: string, data: unknown, args: Args = {}) {
      if (!isRecord(data)) return
      const pid = isNum(data.pid) ? data.pid : targetPid(args)
      const target = isRecord(args.target) ? args.target : args
      const windowId = isNum(data.window_id) ? data.window_id : isNum(target.window_id) ? target.window_id : undefined
      if (pid !== undefined && typeof data.snapshot_id === 'string') snapshots.set(`${session}|${data.snapshot_id}`, { pid, ...(windowId !== undefined ? { windowId } : {}) })
      learnOne(data)
      for (const list of [data.windows, data.apps]) if (Array.isArray(list)) list.forEach(learnOne)
    },
  }
}
type AppDirectory = ReturnType<typeof createAppDirectory>

/** Windows:这个进程 exe 版本信息里的 FileDescription(系统语言的 App 名,资源管理器里看到的就是它)。读不到回空串。 */
async function fileDescriptionOf(ctx: ActionRunContext, pid: number): Promise<string> {
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-Process -Id ${pid} -ErrorAction Stop).Description`
  const r = await ctx.deps.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { ...(ctx.signal ? { signal: ctx.signal } : {}), timeoutMs: 5_000 })
  return r.code === 0 ? r.stdout.replace(/^\uFEFF/, '').trim() : ''
}

/** 小条要写 App 名(取法见 createAppDirectory);每个进程只问一次,都读不到就只写「某个 App」。 */
async function appNameOf(ctx: ActionRunContext, apps: AppDirectory, pid: number): Promise<string | undefined> {
  if (ctx.deps.platform === 'win32' && apps.shouldAskDescription(pid)) {
    try {
      apps.describe(pid, await fileDescriptionOf(ctx, pid))
    } catch {
      // 只影响小条上写哪个名字:往下退到窗口标题、文件名。
    }
  }
  if (apps.shouldAskWindows(pid)) {
    try {
      const result = await ctx.deps.cua().callTool('list_windows', { pid }, { ...(ctx.signal ? { signal: ctx.signal } : {}), timeoutMs: 5_000, lane: sessionOf(ctx) })
      if (!result?.isError) apps.learn('', result?.structuredContent)
    } catch {
      // 只影响小条上写不写得出名字;动作本身照常交给 cua,它有问题会在那一步报出来。
    }
  }
  return apps.nameOf(pid)
}

const FOREGROUND_QUESTION = '要把它正在操作的窗口短暂切到前台吗？这一下会打断你正在用的窗口，做完会切回来。'

function computerAction(t: CuaTool, spec: CuaSpec | undefined, broken: string | null, apps: AppDirectory): ActionDef {
  const name = `computer.${t.cua}`
  const takesSession = !spec || (isRecord(spec.input_schema.properties) && 'session' in spec.input_schema.properties)
  return {
    name,
    group: 'computer',
    title: t.title,
    titleEn: t.titleEn,
    description: descriptionOf(t, spec),
    risk: t.risk ?? (t.kind === 'look' ? 'medium' : 'high'),
    confirm: t.confirm ?? 'never',
    ...(t.question ? { question: t.question } : {}),
    input_schema: schemaOf(spec),
    async run(args, ctx) {
      if (broken) return fail('unsupported', broken)
      const { confirmed, session: _session, ...forward } = args
      const self = ctx.deps.selfApp?.() ?? { pids: new Set<number>(), names: new Set<string>() }
      const checked = checkCall(t.cua, forward, self, ctx.deps.platform)
      if (checked.refused) return fail('invalid_args', checked.refused)
      if (checked.foreground && confirmed !== true) {
        return { ok: false, code: 'needs_confirmation', message: 'The person must agree before 咕咕 brings a window to the front', confirm: { question: checked.question ?? FOREGROUND_QUESTION } }
      }
      const session = sessionOf(ctx)
      const control = ctx.deps.computerControl
      const pid = apps.pidOf(session, forward)
      const windowId = apps.windowOf(session, forward)
      const appName = control && pid !== undefined ? await appNameOf(ctx, apps, pid) : undefined
      const handle = control?.begin({
        ...(ctx.caller?.name ? { callerName: ctx.caller.name } : {}),
        ...(ctx.caller?.task_title ? { taskTitle: ctx.caller.task_title } : {}),
        ...(pid !== undefined ? { pid } : {}),
        ...(windowId !== undefined ? { windowId } : {}),
        ...(appName ? { appName } : {}),
      })
      if (handle && 'refused' in handle) return fail('revoked', handle.refused)
      const signal = handle ? (ctx.signal ? AbortSignal.any([ctx.signal, handle.signal]) : handle.signal) : ctx.signal
      // 人按了停止:这个 App 上在途的这一下被撤,报错其实是「人接过去了」。
      const stopped = () => (handle?.signal.aborted ? fail('revoked', String(handle.signal.reason)) : null)
      try {
        const outcome = await callCua(ctx, name, t.cua, takesSession ? { ...forward, session } : forward, t.timeoutMs?.(args), signal)
        if (outcome.ok) apps.learn(session, outcome.data, forward)
        return stopped() ?? outcome
      } catch (error) {
        const byPerson = stopped()
        if (byPerson) return byPerson
        throw error
      } finally {
        handle?.end()
      }
    },
  }
}

// ───────────────────────── 屏幕(Mac:读前台窗口的辅助功能树) ─────────────────────────

const SCREEN_MAX_EDGE = 1568

/** 截屏失败:像是权限的话回 os_permission,其余照实说。 */
function captureFailure(error: unknown): Outcome {
  const message = error instanceof Error ? error.message : String(error)
  return /permission|denied|not allowed|权限|拒绝/i.test(message)
    ? fail('os_permission', `This computer did not let 咕咕 capture the screen: ${message}`)
    : fail('execution_failed', `Could not capture the screen: ${message}`)
}

interface TreeRow { index: number | null; role: string; label: string; value: string; identifier: string | null }

/** get_window_state 的 tree_markdown 一行:`- [5] AXButton (7) [id=Seven actions=[press]]` / `- AXStaticText = "9,240"`。 */
export function parseTreeRows(markdown: string): TreeRow[] {
  const rows: TreeRow[] = []
  for (const line of markdown.split('\n')) {
    const m = /^\s*-\s+(?:\[(\d+)\]\s+)?(\S+)(.*)$/.exec(line)
    if (!m) continue
    const rest = m[3] ?? ''
    const label = /^\s*\(([^)]*)\)/.exec(rest)?.[1] ?? /^\s*"([^"]*)"/.exec(rest)?.[1] ?? ''
    const value = /=\s*"([^"]*)"/.exec(rest)?.[1] ?? ''
    const identifier = /\[id=([^\s\]]+)/.exec(rest)?.[1] ?? null
    rows.push({ index: m[1] !== undefined ? Number(m[1]) : null, role: m[2]!, label: label.replace(/‎/g, ''), value: value.replace(/‎/g, ''), identifier })
  }
  return rows
}

/** 前台 App 与它最上面的窗口,再读一次那个窗口的辅助功能树(不截图)。 */
async function frontWindowTree(ctx: ActionRunContext, name: string): Promise<Outcome> {
  const apps = await callCua(ctx, name, 'list_apps', {})
  if (!apps.ok) return apps
  const list = isRecord(apps.data) && Array.isArray(apps.data.apps) ? apps.data.apps.filter(isRecord) : []
  const front = list.find((a) => a.active === true)
  if (!front || !isNum(front.pid)) return ok({ app: null, window: null, rows: [] as TreeRow[] })
  const self = ctx.deps.selfApp?.()
  if (self?.pids.has(front.pid)) return fail('invalid_args', '咕咕 itself is in front: 咕咕 does not read its own windows for an agent. Ask the person to switch to the app they mean.')
  const windows = await callCua(ctx, name, 'list_windows', { pid: front.pid })
  if (!windows.ok) return windows
  const all = isRecord(windows.data) && Array.isArray(windows.data.windows) ? windows.data.windows.filter(isRecord) : []
  const win = all.find((w) => w.is_on_screen !== false && (w.layer ?? 0) === 0) ?? all[0]
  if (!win || !isNum(win.window_id)) return ok({ app: front, window: null, rows: [] as TreeRow[] })
  const state = await callCua(ctx, name, 'get_window_state', { pid: front.pid, window_id: win.window_id, include_screenshot: false, session: sessionOf(ctx) })
  if (!state.ok) return state
  const d = state.data as Record<string, unknown>
  return ok({ app: front, window: win, snapshot: typeof d.snapshot_id === 'string' ? d.snapshot_id : null, rows: parseTreeRows(typeof d.tree_markdown === 'string' ? d.tree_markdown : '') })
}

function screenActions(): ActionDef[] {
  const macGet: ActionDef = {
    name: 'screen.get',
    group: 'screen',
    platforms: ['darwin'],
    title: '读屏幕文字',
    titleEn: 'Read screen',
    description: 'Get the text of what is on screen now, from the frontmost app\'s frontmost window (its accessibility tree; no screenshot): app_name, bundle_id, window_title, the visible text lines (texts, cut at max_length characters total, default 4000), and how many controls it exposes. ax_coverage: full = text and controls, partial = only one of them (content may be drawn, e.g. canvas / games), none = nothing readable.',
    risk: 'medium',
    confirm: 'never',
    input_schema: {
      type: 'object',
      properties: { max_length: { type: 'integer', minimum: 100, maximum: TEXT_CAP, description: 'Max total characters of text to return (default 4000)' } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const missing = cuaMissing(ctx)
      if (missing) return missing
      const read = await frontWindowTree(ctx, 'screen.get')
      if (!read.ok) return read
      const d = read.data as { app: Record<string, unknown> | null; window: Record<string, unknown> | null; rows: TreeRow[] }
      const lines = d.rows.flatMap((r) => [r.value, r.index === null ? r.label : ''].filter(Boolean))
      const controls = d.rows.filter((r) => r.index !== null).length
      const maxLength = clampInt(num(args, 'max_length'), 4000, 100, TEXT_CAP)
      const texts: string[] = []
      let used = 0
      let truncated = false
      for (const line of lines) {
        if (used + line.length > maxLength) {
          const rest = maxLength - used
          if (rest > 0) texts.push(line.slice(0, rest))
          truncated = true
          break
        }
        texts.push(line)
        used += line.length
      }
      return ok({
        app_name: typeof d.app?.name === 'string' ? d.app.name : null,
        bundle_id: typeof d.app?.bundle_id === 'string' ? d.app.bundle_id : null,
        window_title: typeof d.window?.title === 'string' ? d.window.title : null,
        texts,
        text_items: lines.length,
        interactive_elements: controls,
        ax_coverage: lines.length > 0 && controls > 0 ? 'full' : lines.length > 0 || controls > 0 ? 'partial' : 'none',
        ...(truncated ? { truncated: true } : {}),
      })
    },
  }

  const otherGet: ActionDef = {
    name: 'screen.get',
    group: 'screen',
    platforms: ['win32', 'linux'],
    title: '看屏幕',
    titleEn: 'See screen',
    description: 'Take a screenshot of this computer\'s main display and return it as a picture you can see (longest edge at most 1568 px). Also returns the image width / height and how many displays are attached (only the main one is captured).',
    risk: 'medium',
    confirm: 'never',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      if (!ctx.deps.captureScreen) return fail('unsupported', 'This build of 咕咕 cannot capture the screen')
      let shot: Awaited<ReturnType<NonNullable<typeof ctx.deps.captureScreen>>>
      try {
        shot = await ctx.deps.captureScreen({ maxEdge: SCREEN_MAX_EDGE })
      } catch (error) {
        return captureFailure(error)
      }
      return ok({ width: shot.width, height: shot.height, displays: shot.displays, pictures: [{ label: 'screen.get screenshot', mimeType: shot.mimeType, data: shot.data }] })
    },
  }

  const find: ActionDef = {
    name: 'screen.elements.find',
    group: 'screen',
    platforms: ['darwin'],
    title: '找屏幕元素',
    titleEn: 'Find on screen',
    description: 'Find UI elements in the frontmost app\'s frontmost window whose label, value or identifier contains query (case-insensitive): role, label, value, identifier, and an element_token (with pid and window_id) that computer.click / computer.set_value accept when "电脑控制 / Computer control" is connected. max_results defaults to 10 (max 50).',
    risk: 'medium',
    confirm: 'never',
    input_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Text to search for (case-insensitive substring)' },
        max_results: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10' },
      },
      additionalProperties: false,
    },
    validate: (args) => (str(args, 'query') ? null : 'query is required'),
    async run(args, ctx) {
      const missing = cuaMissing(ctx)
      if (missing) return missing
      const read = await frontWindowTree(ctx, 'screen.elements.find')
      if (!read.ok) return read
      const d = read.data as { app: Record<string, unknown> | null; window: Record<string, unknown> | null; snapshot: string | null; rows: TreeRow[] }
      const q = str(args, 'query').toLowerCase()
      const hits = d.rows.filter((r) => [r.label, r.value, r.identifier ?? ''].some((s) => s.toLowerCase().includes(q)))
      const max = clampInt(num(args, 'max_results'), 10, 1, 50)
      return ok({
        app_name: typeof d.app?.name === 'string' ? d.app.name : null,
        pid: isNum(d.app?.pid) ? d.app.pid : null,
        window_id: isNum(d.window?.window_id) ? d.window.window_id : null,
        elements: hits.slice(0, max).map((r) => ({
          role: r.role,
          label: r.label,
          value: r.value || null,
          identifier: r.identifier,
          element_token: r.index !== null && d.snapshot ? `${d.snapshot}:${r.index}` : null,
        })),
        count: Math.min(hits.length, max),
        total_matches: hits.length,
      })
    },
  }
  return [macGet, otherGet, find]
}

// ───────────────────────── 动作族 ─────────────────────────

/**
 * 连上「电脑控制」:要两项系统授权(Mac),要到了把 cua-driver 重起一次 —— 它按进程缓存授权,❌ 沿用旧的「没给」。
 *
 * 两项**一次都问**(owner 10-16「这两个权限请求应该是一开始就弄好」):系统还能弹框的各自弹出来,❌ 先问一项、
 * 缺了就停、另一项等下一次点。还缺的一起说出来,带上第一项缺的那一页(runtime 替人打开它,spec system-permissions
 * 「系统不再弹框 → 直接跳到对应的设置页」);缺屏幕录制时说明 macOS 要重启咕咕才生效(`restart`)。
 */
async function probeComputer(ctx: FamilyContext): Promise<Outcome> {
  const missing = cuaMissing(ctx)
  if (missing) return missing
  if (ctx.deps.platform !== 'darwin') return ok(null)
  const ax = await requestHelperPermission(ctx, 'accessibility', '辅助功能')
  const screen = await requestHelperPermission(ctx, 'screen', '屏幕录制')
  ctx.deps.cua().stop('系统授权变了,电脑控制重新启动')
  if (ax.ok && screen.ok) return ok(null)
  const lacking = [...(ax.ok ? [] : ['辅助功能']), ...(screen.ok ? [] : ['屏幕录制'])]
  const first = (ax.ok ? screen : ax) as Outcome & { settingsUrl?: string }
  // 「已打开那一页」由真去打开的 runtime 在打开成功后才补上:❌ 这里先说了,打不开时人干等一个不会出现的窗口。
  const failed = fail('os_permission', `要在 系统设置 → 隐私与安全性 里允许咕咕使用「${lacking.join('」和「')}」` +
    (screen.ok ? '，打开后再点一次「连接」' : '。屏幕录制打开后，macOS 要重启咕咕才生效：重启后再点一次「连接」'))
  return Object.assign(failed, { ...(first.settingsUrl ? { settingsUrl: first.settingsUrl } : {}), ...(screen.ok ? {} : { restart: true as const }) })
}

export function createComputerFamily(nativeDir: string | null): ActionFamily {
  const { specs, broken } = loadCuaTools(nativeDir)
  const apps = createAppDirectory()
  return {
    groups: [
      {
        id: 'computer',
        platforms: ['darwin', 'win32'],
        needs: 'cua',
        iconApp: '/System/Applications/Utilities/Screen Sharing.app',
        ...(process.platform === 'darwin'
          ? { settingsUrl: MAC_PRIVACY('Privacy_Accessibility'), osPermission: '系统设置 → 隐私与安全性 → 辅助功能、屏幕录制 → 打开咕咕' }
          : {}),
        probe: probeComputer,
      },
      {
        id: 'screen',
        platforms: ['darwin', 'win32', 'linux'],
        iconApp: '/System/Applications/Utilities/Screenshot.app',
        // Mac 上读的是辅助功能树(不截图);Windows / Linux 截屏没有能跳过去的系统设置页。
        ...(process.platform === 'darwin'
          ? { settingsUrl: MAC_PRIVACY('Privacy_Accessibility'), osPermission: '系统设置 → 隐私与安全性 → 辅助功能 → 打开咕咕' }
          : {}),
        async probe(ctx) {
          if (ctx.deps.platform === 'darwin') {
            const missing = cuaMissing(ctx)
            if (missing) return missing
            const ax = await requestHelperPermission(ctx, 'accessibility', '辅助功能')
            if (ax.ok) ctx.deps.cua().stop('系统授权变了,电脑控制重新启动')
            return ax
          }
          if (!ctx.deps.captureScreen) return fail('unsupported', '这个版本的咕咕截不了屏')
          try {
            await ctx.deps.captureScreen({ maxEdge: 320 })
            return ok(null)
          } catch (error) {
            return captureFailure(error)
          }
        },
      },
    ],
    actions: [...TOOLS.map((t) => computerAction(t, specs.get(t.cua), broken, apps)), ...screenActions()],
  }
}

/** 测试用:开给 agent 的 cua 工具。 */
export const COMPUTER_TOOLS: readonly string[] = TOOLS.map((t) => t.cua)
