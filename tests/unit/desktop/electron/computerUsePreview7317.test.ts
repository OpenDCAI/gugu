import { describe, expect, it } from 'vitest'
import {
  PREVIEW_CHANGED,
  PREVIEW_TOOL,
  createComputerUsePreview,
  imageSize,
  type ComputerStep,
  type PreviewState,
  type StepResult,
} from '../../../../apps/desktop/electron/computer-use-program'
import type { ExtensionProgram } from '../../../../apps/desktop/electron/session/main/core/extensions/extension-programs'
import { safeParseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import { givesAgentTools } from '../../../../apps/desktop/src/session/shared/extensions/app-places'
import { peekWindow } from '../../../../apps/desktop/electron/device-actions/families/computer'
import { createComputerControl } from '../../../../apps/desktop/electron/device-actions/computer-control'
import { catalogAppsOf, type ExtensionAgentContribution } from '../../../../apps/desktop/electron/extension-session-mcp'
import { COMPUTER_USE_LINE, guguAppsBlock } from '../../../../apps/desktop/electron/capability-bundle'
import { SESSION_TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-session-tool'

/**
 * #7317 Computer Use 的「电脑」页签:agent 经设备动作(`device_call computer.*`)做的每一步,按宿主知道的任务记下,
 * 页面经 App 程序的 `preview_state` 只拿得到它那个任务的。电脑控制本身(#7199 cua-driver)不在这里测:这里测分账、画法依据、
 * 什么时候能要新画面、什么时候把页签开出来。
 */

/** A PNG's first bytes: signature, IHDR length and type, then width and height. */
function png(width: number, height: number): string {
  const head = Buffer.alloc(24)
  head.writeUInt32BE(0x89504e47, 0)
  head.writeUInt32BE(0x0d0a1a0a, 4)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'ascii')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return head.toString('base64')
}

/** A JPEG's first segments: SOI, an APP0 to skip, then SOF0 with height and width. */
function jpeg(width: number, height: number): string {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00])
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]).toString('base64')
}

const app = { extensionId: 'computer-use', server: 'computer-use', native: 'computer-use' } as ExtensionProgram
const signal = new AbortController().signal
const picture = (data: string): StepResult => ({ ok: true, data: { pictures: [{ label: 'computer.get_window_state screenshot', mimeType: 'image/png', data }] } })
const done: StepResult = { ok: true, data: {} }

function setup(options: {
  nativeCursor?: boolean
  installed?: ExtensionProgram[]
  peek?: ((target: { pid: number; window_id: number }) => Promise<StepResult>) | null
  showIn?: (program: ExtensionProgram, target: { projectId: string; sessionId: string }) => Promise<unknown>
} = {}) {
  const notified: string[] = []
  const peeks: { pid: number; window_id: number; maxDimension: number }[] = []
  const viewers: (string | undefined)[] = []
  const cursorSessions: (string | undefined)[] = []
  let clock = 1_000
  let installed = options.installed ?? [app]
  const peek = options.peek === null
    ? null
    : async (target: { pid: number; window_id: number }, opts: { maxDimension: number; viewer?: string; cursorSession?: string }): Promise<StepResult> => {
      peeks.push({ ...target, maxDimension: opts.maxDimension })
      viewers.push(opts.viewer)
      cursorSessions.push(opts.cursorSession)
      return options.peek ? options.peek(target) : { ok: true, data: { pictures: [{ label: 'live', mimeType: 'image/jpeg', data: jpeg(1280, 800) }] } }
    }
  const preview = createComputerUsePreview({
    nativeCursor: options.nativeCursor,
    peek,
    programs: () => installed,
    notify: (program, method) => notified.push(`${program.extensionId}:${method}`),
    ...(options.showIn ? { showIn: options.showIn } : {}),
    now: () => clock,
  })
  /** A whole step: started, then ended with `result`. */
  const act = (sessionId: string, tool: string, args: Record<string, unknown>, result: StepResult | Error = done, where: Partial<ComputerStep> = {}) =>
    preview.step({ projectId: 'project', sessionId, device: 'device:mac', local: true, tool, args, ...where })(result)
  const state = async (sessionId: string | undefined, args: Record<string, unknown> = {}) =>
    (await preview.program.call(app, { name: PREVIEW_TOOL, arguments: args, _meta: sessionId ? { 'gugu/sessionId': sessionId } : {} }, signal))
      .structuredContent as unknown as PreviewState
  return { preview, act, state, notified, peeks, viewers, cursorSessions, tick: (ms: number) => { clock += ms }, install: (next: ExtensionProgram[]) => { installed = next } }
}

describe('#7317 Computer Use 「电脑」 page', () => {
  it('binds a real cursor sample to its frame while a native batch is still running, never to its planned final point', async () => {
    const cursor = { x: 68, y: 422, revision: 'native-step-1', click: true }
    const { preview, act, state, cursorSessions } = setup({ nativeCursor: true, peek: async () => ({ ok: true, data: { pictures: [{ mimeType: 'image/png', data: png(460, 816) }], cursor } }) })
    act('s', 'get_window_state', { pid: 5, window_id: 50 }, picture(png(460, 816)), { cursorSession: 'native-caller-a' })
    const end = preview.step({ projectId: 'p', sessionId: 's', device: 'device:mac', local: true, cursorSession: 'native-caller-a', tool: 'run_steps', args: { pid: 5, window_id: 50, steps: [{ click: { x: 68, y: 422 } }, { click: { x: 392, y: 746 } }] } })
    const value = await state('s', { live: true })
    expect(value.nativeCursor).toBe(true)
    expect(value.frame?.cursor).toEqual(cursor)
    expect(value.actions.at(-1)?.status).toBe('running')
    expect(value.frame?.cursor).not.toEqual(value.actions.at(-1)?.point)
    expect(cursorSessions).toEqual(['native-caller-a'])
    end(done)
  })
  it('gives the App page its preview and agents nothing: computer control stays device_call\'s alone', async () => {
    const { preview } = setup()
    const tools = await preview.program.tools()
    expect(tools.map((tool) => [tool.name, tool._meta])).toEqual([[PREVIEW_TOOL, { ui: { visibility: ['app'] } }]])
    const other = await preview.program.call(app, { name: 'click', arguments: { x: 1, y: 1 }, _meta: { 'gugu/sessionId': 's' } }, signal)
    expect(other.isError).toBe(true)
    expect(JSON.stringify(other.content)).toContain('device_call')
  })

  it('keeps each task to itself: a page sees only the frames and steps of the task it belongs to', async () => {
    const { act, state, notified } = setup()
    act('session-a', 'get_window_state', { pid: 7, window_id: 70 }, picture(png(800, 600)))
    act('session-b', 'get_window_state', { pid: 9, window_id: 90 }, picture(png(1024, 768)))
    act('session-b', 'type_text', { pid: 9, window_id: 90, text: 'hello' })
    const a = await state('session-a')
    const b = await state('session-b')
    expect(a.actions.map((action) => [action.tool, action.status])).toEqual([['get_window_state', 'done']])
    expect(b.actions.map((action) => [action.tool, action.status])).toEqual([['get_window_state', 'done'], ['type_text', 'done']])
    expect([a.frame?.width, b.frame?.width]).toEqual([800, 1024])
    expect(a.target).toEqual({ pid: 7, window_id: 70 })
    // The control: a task that did nothing has nothing, and a page beside no task is told so.
    expect((await state('session-c')).actions).toEqual([])
    expect(await state(undefined)).toEqual({ session: false })
    // Each start and each end told the App's pages.
    expect(notified).toEqual(Array(6).fill(`computer-use:${PREVIEW_CHANGED}`))
  })

  it('sends a frame only when it is newer than the one the page shows', async () => {
    const { act, state } = setup()
    act('s', 'get_window_state', { pid: 1, window_id: 2 }, picture(png(10, 10)))
    const first = await state('s')
    expect(first.frame?.seq).toBe(1)
    const again = await state('s', { since: first.seq })
    expect(again.frame).toBeNull()
    expect(again.seq).toBe(1)
  })

  it('draws a cursor only where a step names window pixels, measured on the screenshot the agent acted on', async () => {
    const { act, state } = setup()
    act('s', 'get_window_state', { pid: 1, window_id: 2 }, picture(png(1600, 1000)))
    act('s', 'click', { pid: 1, window_id: 2, x: 400, y: 300 })
    act('s', 'click', { x: 5, y: 5, scope: 'desktop' })
    act('s', 'click', { pid: 1, window_id: 2, x: 5, y: 5, from_zoom: true })
    act('s', 'click', { element_token: 's0000002a:11' })
    act('s', 'drag', { pid: 1, window_id: 2, from_x: 10, from_y: 20, to_x: 30, to_y: 40 })
    const [look, pixel, desktop, zoomed, element, drag] = (await state('s')).actions
    expect(look.point).toBeUndefined()
    expect(pixel.point).toEqual({ x: 400, y: 300 })
    expect(pixel.space).toEqual({ width: 1600, height: 1000 })
    expect([desktop.point, zoomed.point, element.point]).toEqual([undefined, undefined, undefined])
    expect(drag).toMatchObject({ from: { x: 10, y: 20 }, point: { x: 30, y: 40 } })
  })

  it('draws no cursor for a point whose screenshot it never saw: the first click, another window, the same window number on another device', async () => {
    const { act, state } = setup()
    act('s', 'click', { pid: 1, window_id: 2, x: 400, y: 300 })
    act('s', 'get_window_state', { pid: 1, window_id: 2 }, picture(png(1600, 1000)))
    act('s', 'click', { pid: 1, window_id: 3, x: 400, y: 300 })
    act('s', 'click', { pid: 1, window_id: 2, x: 400, y: 300 }, done, { device: 'device:other', local: false })
    act('s', 'click', { pid: 1, window_id: 2, x: 400, y: 300 })
    const [first, , other, elsewhere, measured] = (await state('s')).actions
    expect([first.point, first.space, other.point, elsewhere.point]).toEqual([undefined, undefined, undefined, undefined])
    expect(measured).toMatchObject({ point: { x: 400, y: 300 }, space: { width: 1600, height: 1000 } })
  })

  it('draws no cursor for a step on another process that names no window: it lands on a window not seen here', async () => {
    const { act, state } = setup()
    act('s', 'get_window_state', { pid: 1, window_id: 2 }, picture(png(1600, 1000)))
    act('s', 'click', { pid: 5, x: 400, y: 300 })
    act('s', 'get_window_state', { pid: 1, window_id: 2 }, picture(png(1600, 1000)))
    act('s', 'click', { pid: 1, x: 400, y: 300 })
    const [, other, , same] = (await state('s')).actions
    expect(other.point).toBeUndefined()
    // Control: the same process with no window named is the window followed, and is drawn on it.
    expect(same).toMatchObject({ point: { x: 400, y: 300 }, space: { width: 1600, height: 1000 } })
  })

  it('follows the process a step names: another one drops the old window and name, a bare app name never relabels a window', async () => {
    const { act, state } = setup()
    act('s', 'get_window_state', { pid: 1, window_id: 2, app_name: 'Calculator' }, picture(png(800, 600)))
    expect((await state('s')).target).toEqual({ pid: 1, window_id: 2, app: 'Calculator' })
    // launch_app names Safari but no process: the window followed is still Calculator's, and keeps its name.
    act('s', 'launch_app', { name: 'Safari' })
    expect((await state('s')).target).toEqual({ pid: 1, window_id: 2, app: 'Calculator' })
    // Its result names Safari's process with no window: neither Calculator's window nor its name carries over.
    act('s', 'launch_app', { name: 'Safari' }, { ok: true, data: { pid: 5 } })
    expect((await state('s')).target).toEqual({ pid: 5, app: 'Safari' })
    // Then a step on Safari's window: followed, named as it was.
    act('s', 'get_window_state', { pid: 5, window_id: 50 }, picture(png(800, 600)))
    expect((await state('s')).target).toEqual({ pid: 5, window_id: 50, app: 'Safari' })
  })

  it('takes only window screenshots as the picture and the measure: a zoom crop or a whole-screen capture is neither', async () => {
    const { act, state } = setup()
    act('s', 'get_window_state', { pid: 1, window_id: 2 }, picture(png(1600, 1000)))
    act('s', 'zoom', { pid: 1, window_id: 2, x: 0, y: 0, width: 400, height: 300 }, picture(png(400, 300)))
    act('s', 'get_desktop_state', {}, picture(png(3024, 1964)))
    act('s', 'click', { pid: 1, window_id: 2, x: 800, y: 500 })
    const after = await state('s')
    expect(after.frame).toMatchObject({ seq: 1, width: 1600 })
    expect(after.actions.at(-1)).toMatchObject({ point: { x: 800, y: 500 }, space: { width: 1600, height: 1000 } })
  })

  it('points the page\'s pictures only at a window a step was done in: a refused step (咕咕 itself, a stopped app) never', async () => {
    const { act, state, peeks } = setup()
    act('s', 'get_window_state', { pid: 4242, window_id: 1 }, { ok: false, code: 'invalid_args', message: 'That is 咕咕 itself' })
    const refused = await state('s', { live: true })
    expect([refused.target, refused.live, peeks]).toEqual([null, false, []])
    // Control: the same look, done, does.
    act('s', 'get_window_state', { pid: 7, window_id: 70 }, picture(png(10, 10)))
    expect((await state('s')).target).toEqual({ pid: 7, window_id: 70 })
  })

  it('takes a fresh read-only picture of the task\'s window while its page is on screen, at most every half second, only on this computer', async () => {
    const { act, state, peeks, tick } = setup()
    act('s', 'get_window_state', { pid: 4, window_id: 40 }, picture(png(2560, 1600)))
    act('s', 'click', { pid: 4, window_id: 40, x: 100, y: 100 })
    const live = await state('s', { live: true })
    expect(peeks).toEqual([{ pid: 4, window_id: 40, maxDimension: 1280 }])
    expect(live.live).toBe(true)
    expect(live.frame).toMatchObject({ source: 'live', width: 1280, height: 800 })
    // The agent's coordinates stay measured on its own screenshot, not on the smaller live picture.
    expect(live.actions[1].space).toEqual({ width: 2560, height: 1600 })
    await state('s', { live: true })
    expect(peeks).toHaveLength(1)
    tick(500)
    await state('s', { live: true })
    expect(peeks).toHaveLength(2)
    // A page that only asks (not on screen) takes none.
    tick(500)
    await state('s')
    expect(peeks).toHaveLength(2)

    // A window on another of the person's devices: its pictures come with the agent's steps only.
    act('r', 'click', { pid: 4, window_id: 40, x: 1, y: 1 }, picture(png(10, 10)), { device: 'device:other', local: false })
    const remote = await state('r', { live: true })
    expect(remote.live).toBe(false)
    expect(peeks).toHaveLength(2)
    // And where there is no computer control at all, none either.
    const none = setup({ peek: null })
    none.act('s', 'click', { pid: 4, window_id: 40, x: 1, y: 1 })
    expect((await none.state('s', { live: true })).live).toBe(false)
  })

  it('never lets the preview reach the agent\'s step: it does not throw, and it does not wait to learn where the step ran', async () => {
    const broken = createComputerUsePreview({
      peek: null,
      programs: () => { throw new Error('extension service gone') },
      notify: () => { throw new Error('listener threw') },
      showIn: async () => undefined,
    })
    const step = { projectId: 'p', sessionId: 's', device: 'device:mac', local: true, tool: 'click', args: { pid: 1, window_id: 2, x: 1, y: 1 } }
    let end: ((ended: StepResult | Error) => void) | undefined
    expect(() => { end = broken.step(step) }).not.toThrow()
    expect(() => end?.(picture(png(10, 10)))).not.toThrow()

    // Where it ran is learned after the step began: no live picture until it is known to be this computer.
    let here!: (local: boolean) => void
    const { preview, state } = setup()
    preview.step({ ...step, local: new Promise<boolean>((resolve) => { here = resolve }) })(picture(png(10, 10)))
    expect((await state('s', { live: true })).live).toBe(false)
    here(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await state('s')).live).toBe(true)
  })

  it('yields to a busy machine: no fresh picture sooner after the last than that one took, and it goes on during a step', async () => {
    // #7317 真机:两个任务的页同时开着时一步 18–30 秒;之后 owner 10-16 看一步做好几下的 run_steps 时画面半分钟不动。
    let advance = (_ms: number) => {}
    const { preview, act, state, peeks, tick } = setup({
      peek: async () => {
        advance(3_000)
        return { ok: true, data: { pictures: [{ label: 'live', mimeType: 'image/jpeg', data: jpeg(640, 400) }] } }
      },
    })
    advance = tick
    act('s', 'get_window_state', { pid: 1, window_id: 2 }, picture(png(1600, 1000)))
    await state('s', { live: true })
    expect(peeks).toHaveLength(1)
    // That one took 3 s on a busy machine: half a second later is too soon, 3 s later is not.
    tick(500)
    await state('s', { live: true })
    expect(peeks).toHaveLength(1)
    tick(2_500)
    await state('s', { live: true })
    expect(peeks).toHaveLength(2)
    // The agent's step is under way: the person still sees the window as it changes.
    tick(3_000)
    const end = preview.step({ projectId: 'project', sessionId: 's', device: 'device:mac', local: true, tool: 'run_steps', args: { pid: 1, window_id: 2, steps: [] } })
    await state('s', { live: true })
    expect(peeks).toHaveLength(3)
    end(done)
  })

  it('takes a run_steps batch as what it is: its closing read is the frame, and the cursor goes through each step in turn', async () => {
    // #7317 owner 10-16:agent 用 run_steps 连做十组加减乘除,画面只在偶尔看一眼时才变,光标也不跟着点。
    const { act, state } = setup()
    act('s', 'get_window_state', { pid: 5, window_id: 50 }, picture(png(460, 816)))
    act('s', 'run_steps', {
      pid: 5, window_id: 50, observe: {},
      steps: [
        { tool: 'click', args: { x: 68, y: 422 } },
        { click: { x: 180, y: 422 } },
        { tool: 'type_text', args: { text: '12' } },
        { tool: 'drag', args: { from_x: 10, from_y: 20, to_x: 30, to_y: 40 } },
        { tool: 'click', args: { pid: 9, window_id: 90, x: 1, y: 1 } },
      ],
    }, picture(png(460, 816)))
    const after = await state('s')
    expect(after.frame).toMatchObject({ seq: 2, source: 'action', width: 460 })
    const batch = after.actions.at(-1)!
    expect(batch.path).toEqual([{ x: 68, y: 422, click: true }, { x: 180, y: 422, click: true }, { x: 10, y: 20 }, { x: 30, y: 40 }])
    expect(batch.point).toEqual({ x: 30, y: 40 })
    expect(batch.space).toEqual({ width: 460, height: 816 })
    // Control: a batch that ends with a zoom hands back the zoomed picture, which is not the window.
    act('s', 'run_steps', { pid: 5, window_id: 50, steps: [{ tool: 'click', args: { x: 1, y: 1 } }, { tool: 'zoom', args: { x: 0, y: 0, width: 10, height: 10 } }] }, picture(png(100, 100)))
    expect((await state('s')).frame).toMatchObject({ seq: 2, width: 460 })
  })

  it('drops a live picture that comes back after a newer frame, or after the agent moved to another window', async () => {
    let release!: () => void
    const { preview, act, state, tick } = setup({
      peek: () => new Promise((resolve) => { release = () => resolve({ ok: true, data: { pictures: [{ label: 'live', mimeType: 'image/jpeg', data: jpeg(640, 400) }] } }) }),
    })
    act('s', 'get_window_state', { pid: 1, window_id: 2 }, picture(png(1600, 1000)))
    const asking = state('s', { live: true })
    // Meanwhile the agent looked at another window.
    act('s', 'get_window_state', { pid: 1, window_id: 3 }, picture(png(800, 500)))
    release()
    await asking
    expect((await state('s')).frame).toMatchObject({ seq: 2, source: 'action', width: 800 })
    // Control: nothing newer meanwhile, and the live picture is kept.
    tick(500)
    const kept = state('s', { live: true })
    release()
    expect((await kept).frame).toMatchObject({ seq: 3, source: 'live', width: 640 })
    expect(preview).toBeDefined()
  })

  it('records a failed step as failed with the first line of what the agent got, and a step waiting for the person as no step', async () => {
    const { preview, act, state } = setup()
    act('s', 'click', { pid: 1, window_id: 2, x: 1, y: 1 }, { ok: false, code: 'os_permission', message: 'Screen Recording is off\nmore detail' })
    act('s', 'launch_app', { app: 'Notes' }, new Error('computer control stopped'))
    act('s', 'set_window_frame', { pid: 1, window_id: 2 }, { ok: false, code: 'needs_confirmation', message: 'ask first' })
    const running = preview.step({ projectId: 'p', sessionId: 's', device: 'device:mac', local: true, tool: 'type_text', args: { text: 'x' } })
    const mid = await state('s')
    expect(mid.actions.map((action) => [action.tool, action.status, action.error])).toEqual([
      ['click', 'failed', 'Screen Recording is off'],
      ['launch_app', 'failed', 'computer control stopped'],
      ['type_text', 'running', undefined],
    ])
    expect(mid.frame).toBeNull()
    running(done)
    running({ ok: false, code: 'timeout', message: 'late' })
    expect((await state('s')).actions.at(-1)?.status).toBe('done')
  })

  it('brings up the page in a task at its agent\'s first step, once per task, and only once an App is there to show it', async () => {
    const shown: string[] = []
    let failNext = true
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    const { preview, act, state, install, notified, tick } = setup({
      installed: [],
      showIn: async (program, target) => {
        shown.push(`${program.extensionId}@${target.projectId}/${target.sessionId}`)
        // The task's page was not loaded the first time: not brought up, so asked again at the next step.
        if (target.sessionId === 'b' && failNext) { failNext = false; throw new Error('timed out waiting for the session pane') }
      },
    })
    act('a', 'get_window_state', { pid: 1, window_id: 2 }, picture(png(10, 10)))
    await settle()
    // No Computer Use App installed: nothing to bring up, nobody told, and nothing kept for an App installed later.
    expect([shown, notified, (await state('a')).actions]).toEqual([[], [], []])
    install([app])
    // A step that did nothing does not bring it up.
    act('a', 'click', { x: 1, y: 1 }, { ok: false, code: 'not_granted', message: 'not connected' })
    await settle()
    expect(shown).toEqual([])
    act('a', 'click', { x: 1, y: 1 })
    act('a', 'type_text', { text: 'x' })
    act('b', 'click', { x: 1, y: 1 })
    await settle()
    // Not asked again at once (the task's page was not loaded): a while later, at its next step.
    act('b', 'click', { x: 1, y: 1 })
    await settle()
    expect(shown).toEqual(['computer-use@project/a', 'computer-use@project/b'])
    tick(60_000)
    act('b', 'click', { x: 1, y: 1 })
    await settle()
    act('b', 'click', { x: 1, y: 1 })
    act('a', 'click', { x: 1, y: 1 })
    // An App's settings saved or another App installed: what the person closed stays closed.
    await preview.program.retire('browser-use')
    act('a', 'click', { x: 1, y: 1 })
    await settle()
    // Once for A (closed afterwards, it stays closed); B twice: the failed try, then the one that worked.
    expect(shown).toEqual(['computer-use@project/a', 'computer-use@project/b', 'computer-use@project/b'])
  })

  it('says why there is no fresh picture, and stops saying it once one comes; each task looks on its own lane', async () => {
    let next: StepResult | Error = { ok: false, code: 'revoked', message: 'The person took over Notes\nmore' }
    const { act, state, tick, viewers } = setup({ peek: async () => { if (next instanceof Error) throw next; return next } })
    act('s', 'get_window_state', { pid: 4, window_id: 40 }, picture(png(800, 600)))
    const refused = await state('s', { live: true })
    // The last picture stays up, saying why it is not fresh: ❌ an old one passing for live.
    expect([refused.live, refused.frame?.source, refused.liveProblem]).toEqual([true, 'action', 'The person took over Notes'])
    tick(500)
    next = new Error('cua-driver lane did not start')
    expect((await state('s', { live: true })).liveProblem).toBe('cua-driver lane did not start')
    tick(500)
    next = { ok: true, data: { pictures: [{ label: 'live', mimeType: 'image/jpeg', data: jpeg(1280, 800) }] } }
    const fresh = await state('s', { live: true })
    expect([fresh.frame?.source, fresh.liveProblem]).toEqual(['live', undefined])
    // Two tasks: two viewers, so one task's stuck window never queues the other's look.
    act('t', 'get_window_state', { pid: 5, window_id: 50 }, picture(png(800, 600)))
    await state('t', { live: true })
    expect([...new Set(viewers)]).toEqual(['s', 't'])
  })

  it('forgets what it saw when Computer Use is switched off: an App installed later never sees what came before', async () => {
    const { preview, act, state } = setup()
    act('s', 'get_window_state', { pid: 4, window_id: 40 }, picture(png(800, 600)))
    expect((await state('s')).actions).toHaveLength(1)
    preview.forget()
    const after = await state('s')
    expect([after.frame, after.actions, after.target]).toEqual([null, [], null])
    // Control: what comes after is recorded again.
    act('s', 'click', { pid: 4, window_id: 40, x: 1, y: 1 })
    expect((await state('s')).actions).toHaveLength(1)
  })

  it('looks at a window on the viewing task\'s own lane, so a stuck look holds up only that task\'s page', async () => {
    const lanes: unknown[] = []
    const cua = {
      callTool: async (_name: string, _args: Record<string, unknown>, options?: { lane?: string }) => {
        lanes.push(options?.lane)
        return { content: [] }
      },
    }
    await peekWindow(() => ({ ok: true }), cua, { pid: 4, window_id: 40 }, { maxDimension: 1280, viewer: 'session-a' })
    await peekWindow(() => ({ ok: true }), cua, { pid: 4, window_id: 40 }, { maxDimension: 1280, viewer: 'session-b' })
    expect(lanes).toEqual(['gugu-preview:session-a', 'gugu-preview:session-b'])
  })

  it('peeks at a window under the agent\'s own permission to look at it, read-only, and not at all without that permission', async () => {
    const calls: [string, Record<string, unknown>][] = []
    const cua = {
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push([name, args])
        return { content: [{ type: 'image' as const, mimeType: 'image/png', data: png(1280, 800) }] }
      },
    }
    const asked: string[] = []
    const refused = await peekWindow((action) => (asked.push(action), { ok: false, code: 'not_granted', message: 'not connected' }), cua, { pid: 4, window_id: 40 }, { maxDimension: 1280 })
    expect(refused).toEqual({ ok: false, code: 'not_granted', message: 'not connected' })
    expect([asked, calls]).toEqual([['computer.get_window_state'], []])
    const seen = await peekWindow(() => ({ ok: true }), cua, { pid: 4, window_id: 40 }, { maxDimension: 1280 })
    expect(calls).toEqual([['get_window_state', { pid: 4, window_id: 40, include_accessibility_tree: false, display_only: true, max_dimension: 1280 }]])
    expect(seen.ok && (seen.data as { pictures: { data: string }[] }).pictures.map((p) => imageSize(p.data))).toEqual([{ width: 1280, height: 800 }])

    // Not 咕咕 itself, and not an app the person stopped: refused before the computer is asked.
    const view = { show: () => undefined, hide: () => undefined }
    const control = createComputerControl({ view })
    control.begin({ pid: 9, appName: 'Notes' })
    control.stop()
    const guards = { self: () => ({ pids: new Set([4242]), names: new Set<string>() }), stoppedFor: (pid: number) => control.stoppedFor(pid) }
    const own = await peekWindow(() => ({ ok: true }), cua, { pid: 4242, window_id: 1 }, { maxDimension: 1280 }, guards)
    const stopped = await peekWindow(() => ({ ok: true }), cua, { pid: 9, window_id: 1 }, { maxDimension: 1280 }, guards)
    expect([own.ok, stopped.ok && false, !stopped.ok && stopped.code]).toEqual([false, false, 'revoked'])
    expect(calls).toHaveLength(1)
    // Control: another app is not stopped, and once the person lets it continue neither is this one.
    expect(control.stoppedFor(8)).toBeNull()
    control.resume()
    expect(control.stoppedFor(9)).toBeNull()
  })

  it('is never asked 「给哪些 agent」: that question is about tools, and it gives agents none (125 10-05)', () => {
    const tools = { permissions: { capabilities: ['agents:tools' as const] } }
    expect(givesAgentTools({ ...tools, contributes: { mcpServers: [{ name: 'computer-use', host: 'computer-use' as const }] } })).toBe(false)
    // Controls: skills beside it do reach agents; Browser Use's tools do; an App not asking for agents:tools never did.
    expect(givesAgentTools({ ...tools, contributes: { mcpServers: [{ name: 'computer-use', host: 'computer-use' as const }], skills: 'skills' } })).toBe(true)
    expect(givesAgentTools({ ...tools, contributes: { mcpServers: [{ name: 'browser-use', host: 'browser-use' as const }] } })).toBe(true)
    expect(givesAgentTools({ permissions: { capabilities: [] }, contributes: { mcpServers: [{ name: 'browser-use', host: 'browser-use' as const }] } })).toBe(false)
  })

  // The owner's test (67f2a4fc): told 「用我的电脑计算器按一个 6+6+6+6+6 的和」, agents scripted Calculator with osascript
  // or took the browser's mouse for computer control; device_actions was in their list all along.
  it('on, it routes the person\'s apps through device_actions / device_call without banning test-app debugging; off, it says nothing', () => {
    const contribution = (extensionId: string) => ({ extensionId, name: extensionId === 'computer-use' ? 'Computer Use' : extensionId, disclosure: 'progressive' }) as unknown as ExtensionAgentContribution
    const program = (extensionId: string, native?: 'computer-use' | 'browser-use') => ({ extensionId, server: extensionId, ...(native ? { native } : {}) }) as ExtensionProgram
    const on = catalogAppsOf([contribution('computer-use'), contribution('browser-use'), contribution('board')],
      [program('computer-use', 'computer-use'), program('browser-use', 'browser-use'), program('board')])
    expect(on).toEqual([{ extensionId: 'computer-use', name: 'Computer Use', computerUse: true }, { extensionId: 'browser-use', name: 'browser-use' }, { extensionId: 'board', name: 'board' }])
    const block = guguAppsBlock(on, [])
    expect(block).toContain(COMPUTER_USE_LINE)
    expect(COMPUTER_USE_LINE.length).toBeLessThanOrEqual(250)
    expect(COMPUTER_USE_LINE).toBe('Computer Use is on: use browser_* tools for webpages in this session\'s own browser tabs. Use device_actions with group computer, then device_call, only for the person\'s other desktop apps.')
    expect(SESSION_TOOL_DEFS.find((tool) => tool.name === 'device_actions')?.description)
      .toBe('Inspect native actions; Computer Use: control macOS/Windows desktop apps (screen, mouse, keys; computer). Omit device: devices/status/timezone/groups. With device: actions; group/name: read schema first. Other-device work: session_spawn there. available:false has unavailable_detail.')
    // It has no tools in the catalog: not one of the Apps that say "run them with catalog_call".
    expect(block).not.toMatch(/- Computer Use \(computer-use\)/)
    expect(block).toMatch(/- browser-use \(browser-use\)/)
    // Off (its program not running): no line, no token.
    const off = catalogAppsOf([contribution('computer-use'), contribution('board')], [program('board')])
    expect(off).toEqual([{ extensionId: 'board', name: 'board' }])
    expect(guguAppsBlock(off, [])).not.toContain('Computer Use')
  })

  it('accepts a tab declared one per task, and refuses it on the settings page or a tab that opens files', () => {
    const manifest = (tab: Record<string, unknown>) => ({
      id: 'computer-use', name: 'Computer Use', version: '0.2.0', apiVersion: 5,
      permissions: { capabilities: ['agents:tools'] },
      contributes: { tabs: [{ name: 'settings', title: 'Settings', hostPage: 'settings' }, tab], mcpServers: [{ name: 'computer-use', host: 'computer-use' }] },
    })
    const screen = { name: 'preview', title: '电脑', entry: 'app/preview.html', perSession: true }
    expect(safeParseExtensionManifest(manifest(screen)).ok).toBe(true)
    expect(safeParseExtensionManifest(manifest({ ...screen, opensFiles: { session: ['.png'] } })).ok).toBe(false)
    expect(safeParseExtensionManifest(manifest({ name: 'own', title: 'Own', hostPage: 'settings', perSession: true })).ok).toBe(false)
    expect(safeParseExtensionManifest(manifest({ ...screen, perSession: false })).ok).toBe(false)
  })

  it('reads the pixel size of PNG and JPEG frames, and says null for anything else', () => {
    expect(imageSize(png(2880, 1800))).toEqual({ width: 2880, height: 1800 })
    expect(imageSize(jpeg(1280, 720))).toEqual({ width: 1280, height: 720 })
    expect(imageSize(Buffer.from('GIF89a').toString('base64'))).toBeNull()
  })
})
