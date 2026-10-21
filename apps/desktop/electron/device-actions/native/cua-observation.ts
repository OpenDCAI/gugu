import { createHash } from 'node:crypto'
import type { CuaToolResult } from './cua-client'
import { sameCuaImageSample } from './cua-image-sample'
import { coreLogger } from '@gugu/core/log'

const log = coreLogger('computer-observation')

type Args = Record<string, unknown>
type Read = (name: string, args: Args) => Promise<CuaToolResult>
const object = (value: unknown): value is Args => !!value && typeof value === 'object' && !Array.isArray(value)
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** During the agent's closing observation, preview readers share that fresh
 * capture instead of starting competing native camera requests. Inputs are
 * never queued on the preview, and long-running batches still have live video. */
export function createObservationGate() {
  const active = new Map<string, Promise<CuaToolResult>>()
  const key = (args: Args) => number(args.pid) && number(args.window_id) ? `${args.pid}:${args.window_id}` : null
  return {
    following(args: Args): Promise<CuaToolResult> | null { return active.get(key(args) ?? '') ?? null },
    async observe(args: Args, work: () => Promise<CuaToolResult>): Promise<CuaToolResult> {
      const window = key(args)
      if (!window) return work()
      const result = Promise.resolve().then(work)
      active.set(window, result)
      try { return await result } finally { if (active.get(window) === result) active.delete(window) }
    },
  }
}

export function displayOnlyObservation(result: CuaToolResult): CuaToolResult {
  if (result.isError) return result
  const allowed = new Set(['app_name', 'pid', 'window_id', 'window_title', 'window_bounds', 'screenshot_width', 'screenshot_height', 'screenshot_scale', 'screenshot_mime_type', 'screenshot_frame_valid'])
  return { content: result.content?.filter(block => block.type === 'image'), structuredContent: { ...Object.fromEntries(Object.entries(result.structuredContent ?? {}).filter(([key]) => allowed.has(key))), display_only: true } }
}

export function transientObservationError(result: CuaToolResult): boolean {
  return result.isError === true && (result.content ?? []).some(block => block.type === 'text' && /No content produced|px_frame_mismatch|px_capture_unavailable/i.test(block.text ?? ''))
}

function frame(result: CuaToolResult, sampleImage?: (base64: string) => Uint8Array) {
  const data = result.structuredContent
  const bounds = data?.window_bounds
  const image = result.content?.findLast(block => block.type === 'image' && typeof block.data === 'string')
  if (result.isError || !image?.data || !object(bounds) || data?.screenshot_frame_valid === false) return null
  return { bounds, fingerprint: createHash('sha256').update(sampleImage ? '' : image.data).update(JSON.stringify([bounds, data?.screenshot_width, data?.screenshot_height])).digest('hex'), pixels: sampleImage?.(image.data) }
}

function sameFrame(a: ReturnType<typeof frame>, b: NonNullable<ReturnType<typeof frame>>): boolean {
  return a?.fingerprint === b.fingerprint && (a.pixels && b.pixels ? sameCuaImageSample(a.pixels, b.pixels) : !a.pixels && !b.pixels)
}

function matchesWindow(result: CuaToolResult, bounds: Args, windowId: number): boolean {
  const windows = result.structuredContent?.windows
  if (result.isError || !Array.isArray(windows)) return false
  const window = windows.find(value => object(value) && value.window_id === windowId) as Args | undefined
  const current = window?.bounds
  return object(current) && ['x', 'y', 'width', 'height'].every(key => current[key] === bounds[key])
}

/** Wait for observed pixels AND current WindowServer geometry, not merely a
 * successful input dispatch. Bounded quiet samples are evidence, not a promise
 * that an app will never update again. A timeout is explicitly returned. */
interface ObservationInput {
  initial: CuaToolResult
  args: Args
  read: Read
  budgetMs: number
  now?: () => number
  pause?: (ms: number) => Promise<void>
  sampleImage?: (base64: string) => Uint8Array
}

export async function settleCuaWindow(input: ObservationInput): Promise<CuaToolResult> {
  const started = (input.now ?? Date.now)()
  try { return await settleWindow(input) } catch (error) {
    log.warn({ error: String(error), pid: input.args.pid, window_id: input.args.window_id }, 'post-action image sampling failed')
    return { isError: true, content: [{ type: 'text', text: 'Post-action image sampling failed. The input may already have completed; read again before acting.' }], structuredContent: { observation_stability: { status: 'unavailable', elapsed_ms: (input.now ?? Date.now)() - started } } }
  }
}

async function settleWindow(input: ObservationInput): Promise<CuaToolResult> {
  const { args, read } = input
  if (!number(args.pid) || !number(args.window_id) || args.include_screenshot === false) return input.initial
  const now = input.now ?? Date.now
  const pause = input.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const started = now()
  let latest = input.initial
  // Keep the original native image/state/handles together. Verification reads
  // must neither repeat AX/background probing nor replace those action handles.
  let grounded = input.initial
  let groundedFrame = grounded.structuredContent?.display_only === true && args.display_only !== true ? null : frame(grounded, input.sampleImage)
  const sampleArgs = { ...args, include_accessibility_tree: false, display_only: true, full_output: false, verbose: false }
  let changedAt = started
  let samples = groundedFrame ? 1 : 0
  let matches = false
  let stable = false
  let checkedAt: number | null = null
  let deadlineReached = false
  while (now() - started < input.budgetMs) {
    await pause(Math.min(60, Math.max(0, input.budgetMs - (now() - started))))
    if (now() - started >= input.budgetMs) break
    let next: CuaToolResult
    let windows: CuaToolResult
    const reground = !groundedFrame
    try {
      next = await read('get_window_state', reground ? args : sampleArgs)
      if (next.isError) {
        if (!transientObservationError(next)) return next
        groundedFrame = null; changedAt = now(); latest = next; matches = false
        continue
      }
      windows = await read('list_windows', { pid: args.pid, ...(args.session ? { session: args.session } : {}) })
      if (windows.isError) return windows
    } catch (error) {
      if (object(error) && error.code === 'timeout' && now() - started >= input.budgetMs) {
        deadlineReached = true
        log.warn({ error: String(error), pid: args.pid, window_id: args.window_id }, 'post-action observation deadline reached')
        break
      }
      log.warn({ error: String(error), pid: args.pid, window_id: args.window_id }, 'post-action observation failed')
      return { isError: true, content: [{ type: 'text', text: 'Post-action observation failed. The input may already have completed; do not repeat it without reading the window.' }], structuredContent: { observation_stability: { status: 'unavailable', samples, elapsed_ms: now() - started } } }
    }
    const nextFrame = frame(next, input.sampleImage)
    if (!nextFrame) { groundedFrame = null; changedAt = now(); latest = next; matches = false; continue }
    samples++
    latest = next
    matches = matchesWindow(windows, nextFrame.bounds, args.window_id)
    if (!matches) { groundedFrame = null; changedAt = now(); continue }
    checkedAt = now()
    if (reground) {
      grounded = next
      groundedFrame = next.structuredContent?.display_only === true && args.display_only !== true ? null : nextFrame
      changedAt = now()
      continue
    }
    if (!sameFrame(groundedFrame, nextFrame)) { groundedFrame = null; changedAt = now(); continue }
    // A late native reply cannot turn a spent observation budget into success.
    if (now() - started >= input.budgetMs) break
    if (samples >= 2 && now() - started >= 300 && now() - changedAt >= 180) { stable = true; break }
  }
  const observation = { status: stable ? 'stable' : 'timeout', samples, elapsed_ms: now() - started, quiet_ms: now() - changedAt,
    ...(deadlineReached ? { deadline_code: 'timeout' } : {}), ...(checkedAt !== null && matches ? { last_geometry_check_age_ms: now() - checkedAt } : {}) }
  if (!frame(latest, input.sampleImage) || !matches) {
    return { isError: true, content: [{ type: 'text', text: 'The window did not produce a screenshot matching its current geometry before the observation deadline. Read the window again before acting.' }], structuredContent: { observation_stability: observation } }
  }
  // A bounded read can end on an incomplete sample. Keep the last picture
  // already checked against live geometry, explicitly without action handles.
  const shown = stable && args.display_only !== true ? grounded : displayOnlyObservation(stable ? grounded : latest)
  return { ...shown, ...(!stable ? { content: [{ type: 'text', text: 'Post-action sampling timed out. This is the last picture checked against window geometry, for display only; stability was not confirmed. Read the window again before acting.' }, ...(shown.content ?? [])] } : {}), structuredContent: { ...shown.structuredContent, observation_stability: observation } }
}

export function batchObservation(result: CuaToolResult): Args | null {
  const observation = result.structuredContent?.observation
  return object(observation) && observation.ok === true && object(observation.state) ? observation.state : null
}

/** The closing read may fail during an animation and return no state/image.
 * Resolve only windows actually named by native executed-step reports, or by
 * the caller; never repeat a click to obtain its missing observation. */
export function batchObservationArgs(result: CuaToolResult, args: Args): Args | null {
  const steps = Array.isArray(args.steps) ? args.steps : []
  const last = steps.at(-1)
  if (object(last) && (last.tool === 'zoom' || 'zoom' in last)) return null
  const observe = object(args.observe) ? args.observe : {}
  const hasPicture = result.content?.some(block => block.type === 'image') === true
  if (!hasPicture && observe.include_screenshot !== true) return null
  if (!number(result.structuredContent?.executed) || result.structuredContent.executed <= 0) return null
  const reports = result.structuredContent?.steps
  const targets = Array.isArray(reports) ? reports.flatMap(report => {
    const target = object(report) && object(report.target) ? report.target.window : null
    return object(target) ? [target] : []
  }) : []
  const target = batchObservation(result) ?? targets.at(-1) ?? args
  if (!number(target.pid) || !number(target.window_id)) return null
  return { ...observe, pid: target.pid, window_id: target.window_id, include_screenshot: true, ...(args.session ? { session: args.session } : {}) }
}

/** Preserve action outcomes, replace every old observation block and picture,
 * and expose an observation failure separately from an input that already ran. */
export function replaceBatchObservation(result: CuaToolResult, fresh: CuaToolResult): CuaToolResult {
  const header = result.content?.find(block => block.type === 'text')?.text?.split(/\nobservation:/)[0] ?? 'run_steps completed'
  const original = result.structuredContent?.observation
  const initialMessage = object(original) && typeof original.message === 'string' ? original.message : null
  const stability = fresh.structuredContent?.observation_stability
  const timedOut = object(stability) && stability.status === 'timeout'
  const observed = fresh.isError !== true && !timedOut
  return {
    ...result,
    content: [{ type: 'text', text: header }, ...(fresh.content ?? [])],
    structuredContent: {
      ...result.structuredContent,
      observation: { ok: observed, tool: 'get_window_state', state: fresh.structuredContent, summary: !observed ? 'Post-action observation did not settle; read again before acting.' : 'Post-action screenshot checked against current window geometry.', ...(initialMessage ? { initial_message: initialMessage, recovered_initial_observation: observed } : {}) },
    },
  }
}
