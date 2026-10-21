import { describe, expect, it } from 'vitest'
import { batchObservationArgs, createObservationGate, displayOnlyObservation, replaceBatchObservation, settleCuaWindow } from '../../../../apps/desktop/electron/device-actions/native/cua-observation'
import { cursorOnWindow } from '../../../../apps/desktop/electron/device-actions/native/cua-window-cursor'
import type { CuaToolResult } from '../../../../apps/desktop/electron/device-actions/native/cua-client'
import { NativeCallError } from '../../../../apps/desktop/electron/device-actions/native/mac-helper-client'

const shot = (width: number, data = String(width), capture = data): CuaToolResult => ({
  content: [{ type: 'image', mimeType: 'image/png', data }],
  structuredContent: { pid: 1, window_id: 2, screenshot_width: width * 2, screenshot_height: 816, window_bounds: { x: 300, y: 100, width, height: 408 }, capture_id: capture, screenshot_frame_valid: true },
})
const windows = (width: number): CuaToolResult => ({ structuredContent: { windows: [{ window_id: 2, bounds: { x: 300, y: 100, width, height: 408 } }] } })
const args = { pid: 1, window_id: 2, session: 'agent', include_accessibility_tree: false, include_screenshot: true }

describe('post-action screenshot observation', () => {
  it('keeps the first grounding when a second full AX read would exhaust the deadline, using only light pixels and fresh geometry', async () => {
    let clock = 0
    const initial = shot(230, 'same-pixels', 'grounded-capture')
    initial.structuredContent = { ...initial.structuredContent, snapshot_id: 'grounded-snapshot', tree_markdown: 'AX value 46' }
    const calls: Array<{ name: string; values: Record<string, unknown> }> = []
    const result = await settleCuaWindow({ initial, args: { ...args, include_accessibility_tree: true, full_output: true }, budgetMs: 8000, now: () => clock, pause: async ms => { clock += ms }, read: async (name, values) => {
      calls.push({ name, values })
      if (name === 'list_windows') { clock += 120; return windows(230) }
      if (values.include_accessibility_tree !== false || values.display_only !== true) {
        clock = 8000
        throw new NativeCallError('timeout', 'second full AX read blocked')
      }
      clock += 120
      return { ...shot(230, 'same-pixels', 'probe-must-not-escape'), structuredContent: { ...shot(230).structuredContent, display_only: true } }
    } })
    expect(result.structuredContent?.observation_stability).toMatchObject({ status: 'stable', samples: 2, elapsed_ms: 300, last_geometry_check_age_ms: 0 })
    expect(result.content).toBe(initial.content)
    expect(result.structuredContent).toMatchObject({ capture_id: 'grounded-capture', snapshot_id: 'grounded-snapshot', tree_markdown: 'AX value 46' })
    expect(calls.map(call => call.name)).toEqual(['get_window_state', 'list_windows'])
    expect(calls[0]?.values).toMatchObject({ include_accessibility_tree: false, display_only: true, full_output: false, verbose: false })
  })

  it('regrounds changed pixels before stability and returns the image, AX and capture from that single complete native response', async () => {
    let clock = 0
    const initial = shot(230, 'old', 'old-capture')
    const grounded = shot(230, 'new', 'new-capture')
    grounded.structuredContent = { ...grounded.structuredContent, snapshot_id: 'new-snapshot', tree_markdown: 'AX value 46' }
    const reads: Record<string, unknown>[] = []
    const result = await settleCuaWindow({ initial, args, budgetMs: 8000, now: () => clock, pause: async ms => { clock += ms }, read: async (name, values) => {
      clock += 100
      if (name === 'list_windows') return windows(230)
      reads.push(values)
      return values.display_only === true ? shot(230, 'new', 'probe-capture') : grounded
    } })
    expect(reads.map(values => values.display_only === true)).toEqual([true, false, true])
    expect(reads[1]).toBe(args)
    expect(result.structuredContent?.observation_stability).toMatchObject({ status: 'stable', last_geometry_check_age_ms: 0 })
    expect(result.content).toBe(grounded.content)
    expect(result.structuredContent).toMatchObject({ capture_id: 'new-capture', snapshot_id: 'new-snapshot', tree_markdown: 'AX value 46' })
  })

  it('recovers an unusable initial frame with a complete grounding before light confirmation', async () => {
    let clock = 0
    const readArgs: Record<string, unknown>[] = []
    const grounded = shot(230, 'recovered', 'recovered-capture')
    const result = await settleCuaWindow({ initial: { content: [] }, args, budgetMs: 8000, now: () => clock, pause: async ms => { clock += ms }, read: async (name, values) => {
      clock += 100
      if (name === 'list_windows') return windows(230)
      readArgs.push(values)
      return values.display_only === true ? shot(230, 'recovered', 'probe') : grounded
    } })
    expect(readArgs).toHaveLength(2)
    expect(readArgs[0]).toBe(args)
    expect(readArgs[1]).toMatchObject({ include_accessibility_tree: false, display_only: true })
    expect(result.content).toBe(grounded.content)
    expect(result.structuredContent).toMatchObject({ capture_id: 'recovered-capture', observation_stability: { status: 'stable' } })
  })

  it('does not expose action handles for a display-only caller', async () => {
    let clock = 0
    const initial = shot(230, 'same', 'action-capture')
    initial.structuredContent = { ...initial.structuredContent, snapshot_id: 'action-snapshot', elements: [{ element_token: 'action-snapshot:1' }] }
    const result = await settleCuaWindow({ initial, args: { ...args, display_only: true }, budgetMs: 8000, now: () => clock, pause: async ms => { clock += ms }, read: async name => {
      clock += 120
      return name === 'list_windows' ? windows(230) : shot(230, 'same', 'probe')
    } })
    expect(result.content).toEqual(initial.content)
    expect(result.structuredContent).toMatchObject({ display_only: true, observation_stability: { status: 'stable' } })
    for (const key of ['capture_id', 'snapshot_id', 'elements']) expect(result.structuredContent).not.toHaveProperty(key)
  })

  it('never treats a display-only initial picture as action grounding for an ordinary screenshot request', async () => {
    let clock = 0
    const initial = { ...shot(230, 'same', 'preview'), structuredContent: { ...shot(230).structuredContent, display_only: true } }
    const grounded = shot(230, 'same', 'pixel-action-capture')
    const reads: Record<string, unknown>[] = []
    const result = await settleCuaWindow({ initial, args, budgetMs: 8000, now: () => clock, pause: async ms => { clock += ms }, read: async (name, values) => {
      clock += 100
      if (name === 'list_windows') return windows(230)
      reads.push(values)
      return values.display_only === true ? shot(230, 'same', 'probe') : grounded
    } })
    expect(reads[0]).toBe(args)
    expect(result.content).toBe(grounded.content)
    expect(result.structuredContent).toMatchObject({ capture_id: 'pixel-action-capture', observation_stability: { status: 'stable' } })
    expect(result.structuredContent).not.toHaveProperty('display_only')
  })

  it('never stabilizes continuously changing pixels, even when every geometry check matches', async () => {
    let clock = 0
    let captures = 0
    const result = await settleCuaWindow({ initial: shot(230, 'initial'), args, budgetMs: 8000, now: () => clock, pause: async ms => { clock += ms }, read: async name => {
      clock += 100
      return name === 'list_windows' ? windows(230) : shot(230, `changing-${++captures}`)
    } })
    expect(result.structuredContent?.observation_stability).toMatchObject({ status: 'timeout' })
    expect(result.structuredContent).not.toHaveProperty('capture_id')
  })

  it('does not read after an exhausted budget or turn geometry returned after the deadline into stability', async () => {
    let reads = 0
    const empty = await settleCuaWindow({ initial: shot(230), args, budgetMs: 0, read: async () => { reads++; return windows(230) } })
    expect(reads).toBe(0)
    expect(empty.isError).toBe(true)
    let clock = 0
    const late = await settleCuaWindow({ initial: shot(230), args, budgetMs: 8000, now: () => clock, pause: async ms => { clock += ms }, read: async name => {
      if (name === 'list_windows') { clock = 8001; return windows(230) }
      clock += 100
      return shot(230)
    } })
    expect(late.structuredContent).toMatchObject({ display_only: true, observation_stability: { status: 'timeout', elapsed_ms: 8001 } })
    expect(late.structuredContent).not.toHaveProperty('capture_id')
  })

  it('reports cancellation during verification without returning stable action handles or issuing input', async () => {
    let clock = 0
    const calls: string[] = []
    const result = await settleCuaWindow({ initial: shot(230), args, budgetMs: 8000, now: () => clock, pause: async ms => { clock += ms }, read: async name => {
      calls.push(name)
      throw new NativeCallError('execution_failed', 'cancelled during observation')
    } })
    expect(calls).toEqual(['get_window_state'])
    expect(result.isError).toBe(true)
    expect(result.structuredContent?.observation_stability).toMatchObject({ status: 'unavailable' })
    expect(result.structuredContent).not.toHaveProperty('capture_id')
  })

  it('lets a visible preview share an in-progress closing capture, without leaking the agent action handle', async () => {
    const gate = createObservationGate()
    let finish!: (value: CuaToolResult) => void
    const work = gate.observe(args, () => new Promise(resolve => { finish = resolve }))
    const preview = gate.following(args)
    expect(preview).not.toBeNull()
    expect(gate.following({ pid: 1, window_id: 3 })).toBeNull()
    await Promise.resolve()
    const actual = shot(230, 'fresh', 'agent-action-handle')
    finish(actual)
    const viewed = displayOnlyObservation(await preview!)
    expect(viewed.content).toEqual(actual.content)
    expect(viewed.structuredContent).toMatchObject({ display_only: true, screenshot_width: 460 })
    expect(viewed.structuredContent).not.toHaveProperty('capture_id')
    expect((await work).structuredContent?.capture_id).toBe('agent-action-handle')
    expect(gate.following(args)).toBeNull()
  })
  it('recovers an executed click whose initial closing read produced no content', async () => {
    const batch: CuaToolResult = { content: [{ type: 'text', text: 'run_steps: 1/1 steps ok\nobservation: get_window_state ERROR: No content produced (neither AX tree nor screenshot succeeded)' }], structuredContent: { executed: 1, steps: [{ ok: true, target: { window: { pid: 1, window_id: 2 } } }], observation: { ok: false } } }
    const readArgs = batchObservationArgs(batch, { session: 'agent', observe: { include_screenshot: true, include_accessibility_tree: false } })
    expect(readArgs).toEqual(args)
    let clock = 0
    let captures = 0
    const recovered = shot(458, 'open', 'recovered-original')
    const fresh = await settleCuaWindow({ initial: { content: [] }, args: readArgs!, budgetMs: 1500, now: () => clock, pause: async ms => { clock += ms }, read: async (name, values) => {
      clock += 120
      if (name === 'list_windows') return windows(458)
      if (++captures === 1) return { isError: true, content: [{ type: 'text', text: 'No content produced (neither AX tree nor screenshot succeeded)' }] }
      return values.display_only === true ? shot(458, 'open', 'probe') : recovered
    } })
    expect(fresh.structuredContent?.observation_stability).toMatchObject({ status: 'stable' })
    expect(fresh.content).toBe(recovered.content)
    expect(replaceBatchObservation(batch, fresh).structuredContent?.observation).toMatchObject({ ok: true, state: { capture_id: 'recovered-original' } })
  })
  it('does not replace a requested zoom crop with an unrelated whole-window image', () => {
    expect(batchObservationArgs({ structuredContent: { executed: 1 }, content: [{ type: 'image', data: 'zoom' }] }, { ...args, steps: [{ tool: 'zoom', args: {} }] })).toBeNull()
  })
  it('preserves an actual native permission refusal rather than hiding it behind a settle timeout', async () => {
    const refusal: CuaToolResult = { isError: true, content: [{ type: 'text', text: 'Screen Recording permission not granted' }] }
    expect(await settleCuaWindow({ initial: shot(230), args, budgetMs: 500, pause: async () => undefined, read: async () => refusal })).toBe(refusal)
  })
  it('does not accept repeated old pixels while WindowServer already has the new layout', async () => {
    let clock = 0
    let reads = 0
    const names: string[] = []
    const current = shot(230, 'closed', 'current-grounding')
    const result = await settleCuaWindow({ initial: shot(458), args, budgetMs: 2000, now: () => clock, pause: async ms => { clock += ms },
      read: async (name, values) => {
        names.push(name); clock += 150
        if (name === 'list_windows') return windows(230)
        reads++
        return reads <= 2 ? shot(458) : values.display_only === true ? shot(230, 'closed', 'probe') : current
      },
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent?.screenshot_width).toBe(460)
    expect(result.structuredContent?.capture_id).toBe('current-grounding')
    expect(result.content).toBe(current.content)
    expect(result.structuredContent?.observation_stability).toMatchObject({ status: 'stable' })
    expect(reads).toBeGreaterThanOrEqual(4)
    expect(new Set(names)).toEqual(new Set(['get_window_state', 'list_windows']))
  })

  it('times out explicitly and returns no actionable stale image when geometry never matches', async () => {
    let clock = 0
    const result = await settleCuaWindow({ initial: shot(458), args, budgetMs: 500, now: () => clock, pause: async ms => { clock += ms },
      read: async name => { clock += 100; return name === 'list_windows' ? windows(230) : shot(458) },
    })
    expect(result.isError).toBe(true)
    expect(result.content?.some(block => block.type === 'image')).toBe(false)
    expect(result.structuredContent?.observation_stability).toMatchObject({ status: 'timeout' })
  })

  it.each([230, 458])('accounts for the final read deadline after geometry width %i was checked', async width => {
    let clock = 0
    let captures = 0
    const result = await settleCuaWindow({ initial: shot(458, 'old'), args, budgetMs: 500, now: () => clock, pause: async ms => { clock += ms }, read: async name => {
      if (name === 'list_windows') { clock += 60; return windows(width) }
      if (++captures === 2) { clock = 500; throw new NativeCallError('timeout', 'capture deadline reached') }
      clock += 60
      return shot(230, 'new-layout', 'previous-native-action-handle')
    } })
    expect(result.structuredContent?.observation_stability).toMatchObject({ status: 'timeout' })
    if (width === 230) {
      expect(result.isError).not.toBe(true)
      expect(result.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'new-layout' })
      expect(result.structuredContent).toMatchObject({ display_only: true, screenshot_width: 460 })
      expect(result.structuredContent).not.toHaveProperty('capture_id')
      expect(result.structuredContent?.observation_stability).toMatchObject({ last_geometry_check_age_ms: 320, deadline_code: 'timeout' })
      expect(result.structuredContent?.observation_stability).not.toHaveProperty('deadline_error')
      const batch = replaceBatchObservation({ structuredContent: { ok: true, executed: 1 } }, result)
      expect(batch.structuredContent).toMatchObject({ ok: true, executed: 1, observation: { ok: false, state: { display_only: true } } })
      expect(batch.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'new-layout' })
    } else {
      expect(result.isError).toBe(true)
      expect(result.content?.some(block => block.type === 'image')).toBe(false)
    }
  })

  it.each([1, 12])('compares decoded pixels across PNG encoding changes, allowing only one rounding level: %i', async delta => {
    let clock = 0
    let reads = 0
    const result = await settleCuaWindow({ initial: shot(230, 'native'), args, budgetMs: 800, now: () => clock, pause: async ms => { clock += ms },
      sampleImage: data => new Uint8Array([127 + (data === 'shell' ? delta : 0), 100, 90, 255]),
      read: async name => { clock += 60; return name === 'list_windows' ? windows(230) : shot(230, ++reads % 2 ? 'shell' : 'native') },
    })
    expect(result.structuredContent?.observation_stability).toMatchObject({ status: delta === 1 ? 'stable' : 'timeout' })
    expect(reads).toBeGreaterThan(1)
  })

  it('reports a decoder failure rather than silently trusting PNG bytes', async () => {
    const result = await settleCuaWindow({ initial: shot(230), args, budgetMs: 500, sampleImage: () => { throw new Error('broken native PNG') }, read: async () => shot(230) })
    expect(result.isError).toBe(true)
    expect(result.structuredContent?.observation_stability).toMatchObject({ status: 'unavailable' })
    expect(result.content?.some(block => block.type === 'image')).toBe(false)
    expect(JSON.stringify(result.content)).toContain('read again before acting')
    expect(JSON.stringify(result.content)).not.toContain('broken native PNG')
  })

  it('preserves already-executed input outcomes when the following observation fails', async () => {
    let clock = 0
    const failed = await settleCuaWindow({ initial: shot(458), args, budgetMs: 500, now: () => clock, pause: async ms => { clock += ms }, read: async () => { throw new Error('capture transport closed') } })
    const batch: CuaToolResult = { content: [{ type: 'text', text: 'run_steps: 1/1 steps ok\nobservation: old image' }, ...shot(458).content!], structuredContent: { ok: true, executed: 1, failed_step: null, steps: [{ ok: true }] } }
    const result = replaceBatchObservation(batch, failed)
    expect(result.structuredContent).toMatchObject({ ok: true, executed: 1, steps: [{ ok: true }], observation: { ok: false, state: { observation_stability: { status: 'unavailable' } } } })
    expect(result.content?.some(block => block.type === 'image')).toBe(false)
    expect(JSON.stringify(result.content)).not.toContain('old image')
  })
})

describe('native cursor sampled with a window image', () => {
  const cursor = (x = 442, y = 365, session = 'agent', visual = {}): CuaToolResult => ({ structuredContent: { session, enabled: true, position: { x, y }, visual_state: { requested_action: 'click', resolved_action: 'click', phase: 'playing', preempted_count: 3, ...visual } } })
  it('maps real screen points to Retina screenshot pixels using that capture geometry', () => {
    expect(cursorOnWindow(cursor(), cursor(), shot(230))).toMatchObject({ x: 284, y: 530, click: true })
  })
  it('does not put a later cursor on an earlier picture when it moved during capture', () => {
    expect(cursorOnWindow(cursor(), cursor(450), shot(230))).toBeNull()
  })
  it.each([
    { requested_action: 'move' },
    { resolved_action: 'error' },
    { phase: 'idle' },
    { preempted_count: 4 },
  ])('does not pair a gesture transition with old pixels even at an unchanged point: %j', visual => {
    expect(cursorOnWindow(cursor(), cursor(442, 365, 'agent', visual), shot(230))).toBeNull()
  })
  it('does not attach a cursor enabled only after the capture began', () => {
    const before = cursor()
    before.structuredContent!.enabled = false
    expect(cursorOnWindow(before, cursor(), shot(230))).toBeNull()
  })
  it('does not draw another session or an out-of-window cursor', () => {
    expect(cursorOnWindow(cursor(), cursor(442, 365, 'other'), shot(230))).toBeNull()
    expect(cursorOnWindow(cursor(900), cursor(900), shot(230))).toBeNull()
  })
})
