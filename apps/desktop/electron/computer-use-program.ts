/**
 * #7317 Computer Use 的「电脑」页签要看的东西:每个任务的 agent 用咕咕的电脑控制(#7199 设备动作 `device_call computer.*`)
 * 操作的那个窗口的画面,和它的每一步。
 *
 * - 电脑控制只有一条路:agent 的 `device_call`(授权、护栏、「正在操作」小条、「最近调用」都在那一层)。这里 ❌ 另给 agent
 *   一套电脑工具 —— Computer Use App 的程序(`host: 'computer-use'`)只给它自己的页面 `preview_state`。
 * - 按任务记:宿主在 device_call 那里知道是哪条会话调的(❌ 调用方自报)。页面调 `preview_state` 时盖的是那张页所在的会话
 *   (每个任务一份的页签,一生只属于那个任务),所以页面只拿得到它那个任务的。
 * - 画面只记电脑控制交回来的真截图(结果里的 pictures)。页面在屏、要新的一张时,对这个任务正在操作的窗口做一次只读截图
 *   (设备动作的 peekWindow:同一道授权,不是 agent 的动作,`display_only`)—— 只在那个窗口就在这台电脑上时。❌ 造画面。
 * - 鼠标位置只在动作带窗口像素坐标时给(cua 的 x,y = get_window_state 那张截图的窗口像素),连同那张截图的尺寸 ——
 *   预览的新截图可能缩过,页面按比例放。整桌面坐标(scope desktop)、zoom 图里的坐标、按元素点的:不给,❌ 猜。
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { ExtensionProgram, NativeAppProgram } from '@main/core/extensions/extension-programs'
import type { WindowCursor } from './device-actions/native/cua-window-cursor'
import { log } from '@main/lib/logger'

export const PREVIEW_TOOL = 'preview_state'
export const PREVIEW_CHANGED = 'notifications/computer-use/changed'

/** 一步电脑控制怎么结束的:设备动作的结果(`device_call` 原样交回 agent 的那份)。 */
export type StepResult = { ok: true; data?: unknown } | { ok: false; code: string; message: string }

/** agent 的一步电脑控制:哪个任务调的、在哪台设备上、做的是什么。 */
export interface ComputerStep {
  projectId: string
  sessionId: string
  /** Native caller lane derived by the host, never supplied by an App page. */
  cursorSession?: string
  device: string
  /** 那台设备就是这台电脑:只有这时页面才能要新画面。可以晚点才知道 —— ❌ 为了查它让 agent 这一步等。 */
  local: boolean | Promise<boolean>
  /** cua 的工具名(`computer.click` 里的 `click`)。 */
  tool: string
  args: Record<string, unknown>
}

export interface ComputerUsePreview {
  /** Computer Use App 的宿主程序(`host: 'computer-use'`):只有页面的 `preview_state`。 */
  program: NativeAppProgram
  /** 一步开始了;用它怎么结束的调回来。两头都不抛:预览出了什么事只记一笔,❌ 改 agent 拿到的结果。 */
  step(call: ComputerStep): (ended: StepResult | Error) => void
  /** Computer Use 停用 / 卸掉了:记下的画面和每一步一并忘掉,之后再装上的看不到之前的(❌ 越过它的同意)。 */
  forget(): void
}

export interface PreviewFrame { seq: number; mimeType: string; data: string; width: number | null; height: number | null; at: string; source: 'action' | 'live'; cursor?: WindowCursor | null }
export interface PreviewPoint { x: number; y: number }
export interface PreviewAction {
  tool: string
  args: Record<string, string | number | boolean | string[]>
  at: string
  status: 'running' | 'done' | 'failed'
  error?: string
  /** 窗口像素,和 `space`(那张截图的尺寸)一起才有意义。 */
  point?: PreviewPoint
  from?: PreviewPoint
  /** `run_steps`:它每一步落在这个窗口上的点,按先后(拖动是起点再终点);`click` = 这一下是点击。`point` 是最后一个。 */
  path?: Array<PreviewPoint & { click?: true }>
  space?: { width: number; height: number }
}
export interface PreviewTarget { pid?: number; window_id?: number; app?: string }
export interface PreviewState {
  session: boolean
  frame: PreviewFrame | null
  seq: number
  actions: PreviewAction[]
  target: PreviewTarget | null
  live: boolean
  nativeCursor?: boolean
  cursorProblem?: string
  /** 新画面取不到的原因(最近一次没取到,之后还没取到过):页面照实说,❌ 拿上一张冒充在看。 */
  liveProblem?: string
}

const MAX_ACTIONS = 30
const MAX_SESSIONS = 16
const LIVE_EVERY_MS = 500
const LIVE_MAX_DIMENSION = 1280
/** 写进页面的参数:看得懂这一步就够了,❌ 把 agent 的整份参数搬过去。 */
const SHOWN_ARGS = ['app', 'name', 'bundle_id', 'pid', 'window_id', 'x', 'y', 'from_x', 'from_y', 'to_x', 'to_y', 'text', 'key', 'keys',
  'direction', 'value', 'action', 'button', 'count', 'menu_path', 'path']
const NO_TOOLS = "Computer Use gives agents no tools of its own: use device_call with this computer's computer.* actions (see device_actions)."

const previewTool: Tool = {
  name: PREVIEW_TOOL,
  description: "This session's latest computer-control frame and recent actions, for the App's 「电脑」 page.",
  inputSchema: { type: 'object', properties: {
    since: { type: 'number', description: 'The frame number the page already shows.' },
    live: { type: 'boolean', description: 'Take a fresh read-only picture of the window this session works in.' },
  } },
  _meta: { ui: { visibility: ['app'] } },
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function shownArgs(args: Record<string, unknown>): PreviewAction['args'] {
  const shown: PreviewAction['args'] = {}
  for (const key of SHOWN_ARGS) {
    const value = args[key]
    if (isNum(value) || typeof value === 'boolean') shown[key] = value
    else if (typeof value === 'string') shown[key] = value.length > 120 ? `${value.slice(0, 120)}…` : value
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) shown[key] = value.slice(0, 8)
  }
  return shown
}

/** 一步的窗口像素坐标;整桌面、zoom 图里的坐标不算(它们不在那张窗口截图上)。 */
function pointsOfStep(args: Record<string, unknown>): { point?: PreviewPoint; from?: PreviewPoint } {
  if (args.scope === 'desktop' || args.from_zoom === true) return {}
  if (isNum(args.to_x) && isNum(args.to_y)) {
    return { point: { x: args.to_x, y: args.to_y }, ...(isNum(args.from_x) && isNum(args.from_y) ? { from: { x: args.from_x, y: args.from_y } } : {}) }
  }
  return isNum(args.x) && isNum(args.y) ? { point: { x: args.x, y: args.y } } : {}
}

/** `run_steps` 的每一步:`{tool, args}`,或 `{click: {...}}` 这种写法(cua 两种都认)。 */
function stepsOf(args: Record<string, unknown>): Array<{ tool: string; args: Record<string, unknown> }> {
  if (!Array.isArray(args.steps)) return []
  return args.steps.flatMap((step) => {
    if (!isRecord(step)) return []
    if (typeof step.tool === 'string') return [{ tool: step.tool, args: isRecord(step.args) ? step.args : {} }]
    const [tool, inner] = Object.entries(step)[0] ?? []
    return typeof tool === 'string' && isRecord(inner) ? [{ tool, args: inner }] : []
  })
}

/** 这一下的鼠标落点。`run_steps` 一次做好几步:每一步落在批次那个窗口上的点都按先后排进 `path`(点名别的窗口的那步不算)。 */
function pointsOf(tool: string, args: Record<string, unknown>): Pick<PreviewAction, 'point' | 'from' | 'path'> {
  if (tool !== 'run_steps') return pointsOfStep(args)
  const path: NonNullable<PreviewAction['path']> = []
  for (const step of stepsOf(args)) {
    if ((isNum(step.args.pid) && step.args.pid !== args.pid) || (isNum(step.args.window_id) && step.args.window_id !== args.window_id)) continue
    const { point, from } = pointsOfStep(step.args)
    if (from) path.push(from)
    if (point) path.push({ ...point, ...(/click/.test(step.tool) ? { click: true as const } : {}) })
  }
  const last = path.at(-1)
  return last ? { point: { x: last.x, y: last.y }, path } : {}
}

/** 这一步交回来的图是不是它那个窗口的截图(才当画面、才量它的坐标):`run_steps` 收尾那次读窗口算,最后一步是 zoom 的不算。 */
function windowShotOf(tool: string, args: Record<string, unknown>): boolean {
  if (WINDOW_SHOT_TOOLS.has(tool)) return true
  return tool === 'run_steps' && stepsOf(args).at(-1)?.tool !== 'zoom'
}

/** 一张 PNG / JPEG 的像素尺寸(读头几十字节);认不出就是 null —— 页面就不在它上面画鼠标。 */
export function imageSize(base64: string): { width: number; height: number } | null {
  const bytes = Buffer.from(base64.slice(0, 64 * 1024), 'base64')
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) return null
      const marker = bytes[at + 1]
      const length = bytes.readUInt16BE(at + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) }
      }
      at += 2 + length
    }
  }
  return null
}

/** 设备动作结果里的最后一张图(`data.pictures`)。 */
function lastPicture(data: unknown): { mimeType: string; data: string } | null {
  const pictures = isRecord(data) && Array.isArray(data.pictures) ? data.pictures : []
  const last: unknown = pictures.at(-1)
  return isRecord(last) && typeof last.mimeType === 'string' && typeof last.data === 'string' ? { mimeType: last.mimeType, data: last.data } : null
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

type Target = PreviewTarget & { device: string }

/** The cua tools whose picture is one window's screenshot: these become the page's frame and measure an agent's coordinates
 *  (and `run_steps`, whose closing read is one: see `windowShotOf`). */
const WINDOW_SHOT_TOOLS = new Set(['get_window_state'])
/** A task whose page could not be brought up (its pane not loaded) is asked again at most this often. */
const OPEN_RETRY_MS = 60_000

interface SessionRecord {
  frame: PreviewFrame | null
  /** 每个窗口最近一张 agent 自己看到的截图的尺寸(`设备:pid:window_id`):它下一步的坐标落在这张图上。 */
  spaces: Map<string, { width: number; height: number }>
  actions: PreviewAction[]
  /** 它最近一步做成了的那个窗口(❌ 被拒的那一步指的窗口)。 */
  target: Target | null
  cursorSession: string | null
  cursorProblem: string | null
  /** 哪台设备就是这台电脑(查到了才记;没查到 = 不是,不要新画面)。 */
  here: Map<string, boolean>
  /** 上一张新画面取完的时刻、花了多久:下一张至少隔这么久(机器越忙越慢,预览就越让着 agent)。 */
  liveAt: number
  liveTook: number
  live: Promise<void> | null
  /** 最近一次新画面为什么没取到;取到一张就清掉。 */
  liveProblem: string | null
}

export function createComputerUsePreview(deps: {
  /** 这台电脑上一张窗口的只读画面(设备动作的 peekWindow);没有电脑控制的地方是 null。 */
  peek: ((target: { pid: number; window_id: number }, options: { maxDimension: number; signal?: AbortSignal; viewer?: string; cursorSession?: string }) => Promise<StepResult>) | null
  nativeCursor?: boolean
  /** 装着、能跑的 Computer Use App 的宿主程序:页面在它们那里。一个都没有 = 没人看,❌ 记(装上之前的画面不给后装的 App)。 */
  programs: () => ExtensionProgram[]
  /** 告诉 App 的页面:有新的一步(不带会话号,页面自己来取它所在那条会话的)。 */
  notify: (program: ExtensionProgram, method: string) => void
  /**
   * 这个任务的 agent 第一次用电脑做成一步:把 App 每个任务一份的页(「电脑」)开到那个任务里(behavior tab-extensions,#7317)。
   * 本次运行里一个任务只开一次 —— 人关掉了就是不要,❌ 每一步都弹回来;没开成(那个任务的页没在内存里)过一阵再试。
   * 开不开得成都不挡 agent 这一步。
   */
  showIn?: (program: ExtensionProgram, target: { projectId: string; sessionId: string }) => Promise<unknown>
  now?: () => number
}): ComputerUsePreview {
  const now = deps.now ?? (() => Date.now())
  const sessions = new Map<string, SessionRecord>()
  /** 帧号对所有任务一直往上数:一个任务的记录被淘汰后重来,页面手里的旧号也不会挡住新画面。 */
  let frames = 0
  /** 已替它开过页的会话、正在开的、上次没开成的时刻:不随 `sessions` 的淘汰而忘,免得关掉的页过一阵又自己回来。 */
  const shown = new Set<string>()
  const showing = new Set<string>()
  const failedAt = new Map<string, number>()
  const iso = () => new Date(now()).toISOString()

  const notify = (programs: readonly ExtensionProgram[]) => {
    for (const program of programs) deps.notify(program, PREVIEW_CHANGED)
  }
  const showOnce = (programs: readonly ExtensionProgram[], target: { projectId: string; sessionId: string }) => {
    const { showIn } = deps
    const { sessionId } = target
    if (!showIn || programs.length === 0 || shown.has(sessionId) || showing.has(sessionId)) return
    if (now() - (failedAt.get(sessionId) ?? -Infinity) < OPEN_RETRY_MS) return
    showing.add(sessionId)
    Promise.all(programs.map((program) => showIn(program, target)))
      .then(
        () => {
          shown.add(sessionId)
          failedAt.delete(sessionId)
        },
        (error: unknown) => {
          failedAt.set(sessionId, now())
          log.warn('Computer Use could not bring up its page in the task', { sessionId, error: String(error) })
        },
      )
      .finally(() => showing.delete(sessionId))
  }
  /** A task's record, as the most recently used: an agent's step or its page reading it keeps it from being evicted. */
  const touch = (sessionId: string, create: boolean): SessionRecord | null => {
    let record = sessions.get(sessionId)
    if (record) sessions.delete(sessionId)
    else if (create) record = { frame: null, spaces: new Map(), actions: [], target: null, cursorSession: null, cursorProblem: null, here: new Map(), liveAt: 0, liveTook: 0, live: null, liveProblem: null }
    if (!record) return null
    sessions.set(sessionId, record)
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!)
    return record
  }
  const keyOf = (device: string, pid: unknown, windowId: unknown) => (isNum(pid) && isNum(windowId) ? `${device}:${pid}:${windowId}` : null)
  const windowKey = (target: Target | null) => (target ? keyOf(target.device, target.pid, target.window_id) : null)
  const keepFrame = (record: SessionRecord, image: { mimeType: string; data: string }, source: PreviewFrame['source'], cursor?: WindowCursor | null) => {
    const size = imageSize(image.data)
    frames += 1
    record.frame = { seq: frames, mimeType: image.mimeType, data: image.data, width: size?.width ?? null, height: size?.height ?? null, at: iso(), source, ...(deps.nativeCursor ? { cursor: cursor ?? null } : {}) }
    // Only what the agent itself was shown measures its coordinates; a live picture is for the person.
    const key = windowKey(record.target)
    if (source === 'action' && key) {
      if (size) record.spaces.set(key, size)
      else record.spaces.delete(key)
    }
  }
  /** 这一步在哪台设备的哪个窗口、哪个 App 上:从参数和结果里认。换了设备,原来那个窗口就不是它了。 */
  const learnTarget = (record: SessionRecord, device: string, values: Record<string, unknown>) => {
    const base: Target = record.target?.device === device ? record.target : { device }
    const window = isRecord(values.target) && values.target.kind === 'window' ? values.target : values
    const pid = isNum(window.pid) ? window.pid : undefined
    // Another process than the one followed: its old window and name are not this one's (no window named = none known).
    const kept: Target = pid !== undefined && pid !== base.pid ? { device } : base
    const next: Target = pid === undefined ? kept : { ...kept, pid, ...(isNum(window.window_id) ? { window_id: window.window_id } : {}) }
    const app = [values.app_name, values.app, values.name, values.bundle_id].find((v): v is string => typeof v === 'string' && v.length > 0)
    // A name with no process names the window followed only when there is none: ❌ Safari's name on Calculator's window.
    record.target = app && (pid !== undefined || next.pid === undefined) ? { ...next, app } : next
  }

  /** Said once per new reason in the log (a page asks every half second), and to the page until a picture comes. */
  const noteLiveProblem = (sessionId: string, record: SessionRecord, message: string) => {
    const reason = firstLine(message) || 'no picture'
    if (record.liveProblem !== reason) log.warn('Computer Use could not take a fresh picture of the window', { sessionId, reason })
    record.liveProblem = reason
  }

  const preview = async (sessionId: string | null, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> => {
    const since = isNum(args.since) ? args.since : 0
    if (!sessionId) return { content: [{ type: 'text', text: 'Not beside a session.' }], structuredContent: { session: false } }
    const record = touch(sessionId, false)
    const target = record?.target ?? null
    const { peek } = deps
    const live = peek !== null && target !== null && record?.here.get(target.device) === true
    // A fresh picture no sooner after the last one than that one took: the busier the machine, the more the page yields.
    // It goes on during the agent's steps (its look has a lane of its own, so it never queues the agent; a step of
    // several actions can take half a minute, and the person wants to see it happen — owner 10-16).
    const due = record !== null && now() - record.liveAt >= Math.max(LIVE_EVERY_MS, record.liveTook)
    if (record && peek && live && args.live === true && isNum(target?.pid) && isNum(target?.window_id) && (record.live || due)) {
      if (!record.live) {
        const started = now()
        const asked = { frame: record.frame?.seq ?? 0, window: windowKey(record.target) }
        // Each task looks on a lane of its own (`viewer`): one task's stuck window never holds up another's page.
        record.live = peek({ pid: target.pid, window_id: target.window_id }, { maxDimension: LIVE_MAX_DIMENSION, signal, viewer: sessionId, ...(record.cursorSession ? { cursorSession: record.cursorSession } : {}) })
          .then((result) => {
            // Taken before a newer frame came, or of a window the agent has left: older than what is shown, so not shown.
            if ((record.frame?.seq ?? 0) !== asked.frame || windowKey(record.target) !== asked.window) return
            const image = result.ok && lastPicture(result.data)
            if (image) {
              const cursor = isRecord(result.data) ? result.data.cursor as WindowCursor | null | undefined : null
              const problem = isRecord(result.data) && typeof result.data.cursor_problem === 'string' ? firstLine(result.data.cursor_problem) : null
              if (problem && record.cursorProblem !== problem) log.warn('Computer Use could not sample the native cursor', { sessionId, reason: problem })
              record.cursorProblem = problem
              keepFrame(record, image, 'live', cursor)
              record.liveProblem = null
              return
            }
            noteLiveProblem(sessionId, record, result.ok ? 'the look at the window came back without a picture' : result.message)
          })
          // 一张没截到:页面照旧显示上一张、下一次再试,但说出为什么没有新的(❌ 拿上一张冒充在看)。
          .catch((error: unknown) => noteLiveProblem(sessionId, record, error instanceof Error ? error.message : String(error)))
          .finally(() => {
            record.liveAt = now()
            record.liveTook = now() - started
            record.live = null
          })
      }
      await record.live
    }
    const frame = record?.frame ?? null
    const state: PreviewState = {
      session: true,
      frame: frame && frame.seq > since ? frame : null,
      seq: frame?.seq ?? 0,
      actions: record?.actions ?? [],
      target: target
        ? { ...(isNum(target.pid) ? { pid: target.pid } : {}), ...(isNum(target.window_id) ? { window_id: target.window_id } : {}), ...(target.app ? { app: target.app } : {}) }
        : null,
      live,
      ...(deps.nativeCursor ? { nativeCursor: true } : {}),
      ...(record?.cursorProblem ? { cursorProblem: record.cursorProblem } : {}),
      ...(live && record?.liveProblem ? { liveProblem: record.liveProblem } : {}),
    }
    return { content: [{ type: 'text', text: `frame ${state.seq}, ${state.actions.length} actions` }], structuredContent: { ...state } }
  }

  const begin = (call: ComputerStep): ((ended: StepResult | Error) => void) => {
    // Nobody to show it to: nothing is kept, so an App installed later never sees what came before its consent.
    const programs = deps.programs()
    if (programs.length === 0) return () => undefined
    const record = touch(call.sessionId, true)!
    if (call.cursorSession) record.cursorSession = call.cursorSession
    // Whether the device is this computer may be known only later; until it is, it is not.
    if (typeof call.local === 'boolean') record.here.set(call.device, call.local)
    else {
      void call.local.then(
        (local) => { record.here.set(call.device, local) },
        (error: unknown) => log.warn('Computer Use could not tell where a step ran', { sessionId: call.sessionId, error: String(error) }),
      )
    }
    // A point without the screenshot it was measured on is not drawn: no space, no cursor. The window is the one the step
    // names, else the one the agent is working in.
    const points = pointsOf(call.tool, call.args)
    const named = keyOf(call.device, call.args.pid, call.args.window_id)
    // A step naming another process but no window lands on a window not known here: no cursor on the followed one's frame.
    const elsewhere = isNum(call.args.pid) && call.args.pid !== record.target?.pid
    const key = named ?? (!elsewhere && record.target?.device === call.device ? windowKey(record.target) : null)
    const space = key ? record.spaces.get(key) : undefined
    const action: PreviewAction = { tool: call.tool, args: shownArgs(call.args), at: iso(), status: 'running', ...(space ? { ...points, space } : {}) }
    record.actions = [...record.actions, action].slice(-MAX_ACTIONS)
    notify(programs)
    let ended = false
    return (result) => {
      if (ended) return
      ended = true
      try {
        if (result instanceof Error) {
          action.status = 'failed'
          action.error = firstLine(result.message)
        } else if (!result.ok && result.code === 'needs_confirmation') {
          // Nothing was done: it waits for the person to agree. Not a step.
          record.actions = record.actions.filter((item) => item !== action)
        } else if (!result.ok) {
          action.status = 'failed'
          action.error = firstLine(result.message) || result.code
        } else {
          action.status = 'done'
          // Only a step that was done says which window the agent works in: a refused one (咕咕 itself, a stopped app)
          // never points the page's pictures anywhere.
          // Read as one: launch_app's name is in what was asked, the process it started in what came back.
          learnTarget(record, call.device, { ...call.args, ...(isRecord(result.data) ? result.data : {}) })
          const image = lastPicture(result.data)
          if (image && windowShotOf(call.tool, call.args)) keepFrame(record, image, 'action')
        }
        const apps = deps.programs()
        if (action.status === 'done') showOnce(apps, { projectId: call.projectId, sessionId: call.sessionId })
        notify(apps)
      } catch (error) {
        log.warn('Computer Use could not record how a step ended', { sessionId: call.sessionId, tool: call.tool, error: String(error) })
      }
    }
  }

  return {
    forget() {
      // What the person closed stays closed for this run (`shown`): only the record of what was seen goes.
      sessions.clear()
    },
    step(call) {
      try {
        return begin(call)
      } catch (error) {
        log.warn('Computer Use could not record a step', { sessionId: call.sessionId, tool: call.tool, error: String(error) })
        return () => undefined
      }
    },
    program: {
      async tools() {
        return [previewTool]
      },
      async call(_program, params, signal) {
        const sessionId = typeof params._meta?.['gugu/sessionId'] === 'string' && params._meta['gugu/sessionId'] ? params._meta['gugu/sessionId'] : null
        const args = isRecord(params.arguments) ? params.arguments : {}
        if (params.name === PREVIEW_TOOL) return preview(sessionId, args, signal)
        return { isError: true, content: [{ type: 'text', text: NO_TOOLS }] }
      },
      status() {
        return { running: [...sessions.values()].filter((record) => record.actions.some((action) => action.status === 'running')).length }
      },
      // Settings saves, upgrades and installs of any App come here too: what the person closed stays closed, and the
      // record of what agents did stays with the tasks it belongs to.
      async retire() {},
    },
  }
}
