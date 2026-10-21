/** @jsxImportSource solid-js */
/**
 * Height + containment contracts for the tool-family rows redrawn in the
 * #3334 P3 second batch: `tool`, `subagent` and the `tool-group` composite.
 *
 * These rows live in their own file rather than in `height.contract.test.tsx`
 * because that file is a shared magnet: every P3 batch would otherwise edit the
 * same `it.each` table and collide. One file per batch keeps the seam per-lane.
 */

import { ROW_H } from '@session-chat/components/engine/row-metrics'
import { subagentHeader } from '@session-chat/components/rows/tools/subagent/subagent.css'
import { subagentUnitDef } from '@session-chat/components/rows/tools/subagent/subagent.def'
import { toolGroupUnitDef } from '@session-chat/components/rows/tools/tool-group/tool-group.def'
import { toolGroupChildStack } from '@session-chat/components/rows/tools/tool-group/tool-group.css'
import { toolUnitDef } from '@session-chat/components/rows/tools/tool/tool.def'
import { toolName } from '@session-chat/components/rows/tools/tool/tool.css'
import { chevron as collapseChevron } from '@session-chat/components/primitives/collapse-header.css'
import { DEFAULT_THEME } from '@session-chat/core/theme'
import type { ItemNode } from '@session-chat/state/flatten'
import type { ChatSubagentToolCall, ChatToolCall } from '@session-chat/model'
import { afterAll, describe, expect, it } from 'vitest'
import {
  makeContractCtx,
  renderAndMeasureUnit,
  type ContractCtx,
  type HeightContractReading
} from './contract'

const WIDTH = 420
/** Narrow enough that any missing ellipsis rule spills instead of wrapping. */
const NARROW_WIDTH = 180
/** Read from the def so the expectation tracks the same var the render uses. */
const CHILD_GAP = toolGroupUnitDef.vars?.childGap ?? 0
/** Read from the def / theme for the same reason: no second copy of the number. */
const PAYLOAD_MAX_LINES = toolUnitDef.vars?.panelMaxLines ?? 0
const CODE_LINE_H = DEFAULT_THEME.fonts.code.lineHeight
/** Comfortably past the cap, so the capped reading exercises the clamp. */
const CAPPED_RESULT_LINES = PAYLOAD_MAX_LINES * 3
/** Same idea for the failure section, which now answers to that same one cap. */
const FAILURE_TRACE_LINES = PAYLOAD_MAX_LINES * 4

let measuredRows = 0
let renderedElements = 0


function expectHeightMatch(layer: string, reading: HeightContractReading): void {
  const delta = reading.dom - reading.computed
  expect(
    reading.dom,
    `${layer} height mismatch: engine=${reading.computed}px DOM=${reading.dom}px delta=${delta}px`
  ).toBe(reading.computed)
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const tool: ChatToolCall = {
  kind: 'tool',
  id: 'contract-tool',
  name: 'Read',
  status: 'done',
  inputSummary: 'packages/session-chat-ui/src/model.ts'
}

const runningTool: ChatToolCall = {
  kind: 'tool',
  id: 'contract-tool-running',
  name: 'Search',
  status: 'running',
  inputSummary: 'measure contract (4 matches)'
}

const awaitingTool: ChatToolCall = {
  kind: 'tool',
  id: 'contract-tool-awaiting',
  name: 'write_file',
  status: 'running',
  awaitingPermission: true,
  inputSummary: 'apps/desktop/src/session/renderer/index.css'
}

const erroredTool: ChatToolCall = {
  kind: 'tool',
  id: 'contract-tool-error',
  name: 'fetch_design_reference',
  status: 'error',
  error: 'unreachable host',
  inputSummary: 'https://example.invalid/reference'
}

/**
 * The product shape of a failure: the reason arrived in `result`, because that
 * is the field ACP's failing `tool_call_update` content decodes into. Nothing
 * sets `error` on that path, so a fixture that only ever sets `error` would test
 * a row the product never renders.
 */
const REASON = 'getaddrinfo ENOTFOUND example.invalid'
const failedTool: ChatToolCall = {
  kind: 'tool',
  id: 'contract-tool-failed',
  name: 'Fetch',
  status: 'error',
  inputSummary: 'https://example.invalid/reference',
  result: REASON
}

/** A host that holds the reason apart from the output: both, and they differ. */
const failedToolWithRequest: ChatToolCall = {
  kind: 'tool',
  id: 'contract-tool-failed-request',
  name: 'mcp__db__query',
  status: 'error',
  inputSummary: 'db.query',
  error: REASON,
  request: '{"sql":"select 1"}',
  result: 'connection refused after 3s'
}

/** A stack trace: the shape that must not turn a run of failures into a wall. */
const stackFailedTool: ChatToolCall = {
  kind: 'tool',
  id: 'contract-tool-failed-stack',
  name: 'mcp__db__query',
  status: 'error',
  inputSummary: 'db.query',
  result: Array.from(
    { length: FAILURE_TRACE_LINES },
    (_, index) => `    at frame-${index} (/src/db/query.ts:${index}:11)`
  ).join('\n')
}

// Both cells are far wider than the host. The row carries no border and no
// background, so nothing marks its right edge: a broken ellipsis rule would
// push the summary into the next column and still read as an ordinary long
// line. This is the sentinel for that.
const overflowingTool: ChatToolCall = {
  kind: 'tool',
  id: 'contract-tool-overflow',
  name: `${'extremely-long-tool-name-'.repeat(4)}handler`,
  status: 'done',
  inputSummary: `${'deeply-nested-directory/'.repeat(8)}component.tsx`
}

// A single very long JSON line for the request — the shape a tool's arguments
// actually arrive in — plus a short multi-line result, so the expanded reading
// exercises wrapping and multi-source-line layout in the same row.
const payloadTool: ChatToolCall = {
  kind: 'tool',
  id: 'contract-tool-payload',
  name: 'Search',
  status: 'done',
  inputSummary: 'measure contract (4 matches)',
  request:
    '{"pattern":"measure contract","path":"packages/session-chat-ui/src","glob":"**/*.{ts,tsx}","caseSensitive":false,"maxResults":50}',
  result: '4 matches in 3 files\npackages/task-chat-ui/src/core/define.ts:12\nREADME.md:88'
}

const cappedPayloadTool: ChatToolCall = {
  kind: 'tool',
  id: 'contract-tool-payload-capped',
  name: 'MCP',
  status: 'done',
  inputSummary: 'files.list',
  request: '{"dir":"src"}',
  result: Array.from({ length: CAPPED_RESULT_LINES }, (_, index) => `src/file-${index}.ts`).join(
    '\n'
  )
}

const runningSubagent: ChatSubagentToolCall = {
  kind: 'subagent',
  id: 'contract-subagent-running',
  name: 'visual-auditor',
  status: 'running',
  phase: 'running',
  agentId: 'agent-1',
  background: true
}

const completedSubagent: ChatSubagentToolCall = {
  kind: 'subagent',
  id: 'contract-subagent-done',
  name: 'height-auditor',
  status: 'done',
  phase: 'completed',
  agentId: 'agent-2'
}

const failedSubagent: ChatSubagentToolCall = {
  kind: 'subagent',
  id: 'contract-subagent-failed',
  name: 'contract-runner',
  status: 'error',
  phase: 'failed',
  error: 'subagent exited non-zero'
}

// The name alone is wider than the narrow host; the phase label follows it on
// the same line, so a missing shrink rule shows up as a spill.
const overflowingSubagent: ChatSubagentToolCall = {
  kind: 'subagent',
  id: 'contract-subagent-overflow',
  name: `${'extremely-long-subagent-name-'.repeat(4)}auditor`,
  status: 'running',
  phase: 'running',
  agentId: 'agent-3'
}

function leaf(item: ChatToolCall | ChatSubagentToolCall): ItemNode {
  return { item, children: [] }
}

/** A running tool parent with four leaf tool children. */
const toolGroup: ItemNode = {
  item: {
    kind: 'tool',
    id: 'contract-tool-group',
    name: 'Read',
    status: 'running',
    inputSummary: 'nested primitives'
  } satisfies ChatToolCall,
  children: [
    leaf({ kind: 'tool', id: 'contract-group-child-0', name: 'Read', status: 'done' }),
    leaf({ kind: 'tool', id: 'contract-group-child-1', name: 'Read', status: 'done' }),
    leaf({ kind: 'tool', id: 'contract-group-child-2', name: 'Read', status: 'done' }),
    leaf({ kind: 'tool', id: 'contract-group-child-3', name: 'Read', status: 'done' })
  ]
}

/**
 * Enough children that the collapsed height exceeds ToolGroupVars.windowH, so
 * the collapsed reading exercises the Math.min clamp and the PreviewWindow
 * branch instead of re-testing the same short list as the expanded case.
 */
const cappedToolGroup: ItemNode = {
  item: {
    kind: 'tool',
    id: 'contract-tool-group-capped',
    name: 'Read',
    status: 'running',
    inputSummary: 'capped preview'
  } satisfies ChatToolCall,
  children: Array.from({ length: 12 }, (_, index) =>
    leaf({
      kind: 'tool',
      id: `contract-capped-child-${index}`,
      name: 'Read',
      status: 'done',
      inputSummary: `src/file-${index}.ts`
    })
  )
}

/** A subagent parent: the branch that takes SubagentHeader and the child inset. */
const subagentGroup: ItemNode = {
  item: runningSubagent,
  children: [
    leaf({ kind: 'tool', id: 'contract-subagent-child-0', name: 'Read', status: 'done' }),
    leaf({ kind: 'tool', id: 'contract-subagent-child-1', name: 'Search', status: 'done' })
  ]
}

/** Two levels of nesting: the recursive ToolGroupRender branch. */
const nestedToolGroup: ItemNode = {
  item: {
    kind: 'tool',
    id: 'contract-tool-group-outer',
    name: 'Task',
    status: 'running'
  } satisfies ChatToolCall,
  children: [
    leaf({ kind: 'tool', id: 'contract-outer-child', name: 'Read', status: 'done' }),
    {
      item: {
        kind: 'tool',
        id: 'contract-tool-group-inner',
        name: 'Read',
        status: 'running'
      } satisfies ChatToolCall,
      children: [
        leaf({ kind: 'tool', id: 'contract-inner-child-0', name: 'Read', status: 'done' }),
        leaf({ kind: 'tool', id: 'contract-inner-child-1', name: 'Read', status: 'done' })
      ]
    }
  ]
}

const expandedCtx = (...ids: string[]): ContractCtx =>
  makeContractCtx({ width: WIDTH, isCollapsed: (candidate) => ids.includes(candidate) })

// ── Height contracts ──────────────────────────────────────────────────────────

describe('tool-family measure to rendered border-box height contract', () => {
  it.each([
    {
      label: 'tool row',
      run: () => renderAndMeasureUnit(toolUnitDef, tool, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'tool row (running)',
      run: () => renderAndMeasureUnit(toolUnitDef, runningTool, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'tool row (awaiting permission)',
      run: () => renderAndMeasureUnit(toolUnitDef, awaitingTool, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'tool row (error)',
      run: () => renderAndMeasureUnit(toolUnitDef, erroredTool, makeContractCtx({ width: WIDTH }))
    },
    {
      // Collapsed: a header and nothing else, exactly like a successful row.
      // The failure section waits to be asked for now.
      label: 'tool row (failed, collapsed)',
      run: () => renderAndMeasureUnit(toolUnitDef, failedTool, makeContractCtx({ width: WIDTH }))
    },
    {
      // Expanded, because collapsed there is no trace on screen to cap.
      label: 'tool row (failed, capped trace)',
      run: () =>
        renderAndMeasureUnit(toolUnitDef, stackFailedTool, expandedCtx(stackFailedTool.id))
    },
    {
      label: 'tool row (failed, expanded over its request)',
      run: () =>
        renderAndMeasureUnit(
          toolUnitDef,
          failedToolWithRequest,
          expandedCtx(failedToolWithRequest.id)
        )
    },
    {
      label: 'subagent row (running)',
      run: () =>
        renderAndMeasureUnit(subagentUnitDef, runningSubagent, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'subagent row (completed)',
      run: () =>
        renderAndMeasureUnit(subagentUnitDef, completedSubagent, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'subagent row (failed)',
      run: () =>
        renderAndMeasureUnit(subagentUnitDef, failedSubagent, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'tool-group row (expanded)',
      run: () =>
        renderAndMeasureUnit(toolGroupUnitDef, toolGroup, expandedCtx(toolGroup.item.id))
    },
    {
      label: 'tool-group row (collapsed preview, clamped)',
      run: () =>
        renderAndMeasureUnit(toolGroupUnitDef, cappedToolGroup, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'tool-group row (subagent parent, expanded)',
      run: () =>
        renderAndMeasureUnit(toolGroupUnitDef, subagentGroup, expandedCtx(subagentGroup.item.id))
    },
    {
      label: 'tool-group row (subagent parent, collapsed)',
      run: () =>
        renderAndMeasureUnit(toolGroupUnitDef, subagentGroup, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'tool-group row (two levels, both expanded)',
      run: () =>
        renderAndMeasureUnit(
          toolGroupUnitDef,
          nestedToolGroup,
          expandedCtx(nestedToolGroup.item.id, 'contract-tool-group-inner')
        )
    }
  ])('$label', async ({ label, run }) => {
    const reading = await run()
    measuredRows += 1
    renderedElements += reading.renderedElements
    expectHeightMatch(label, reading)
  })
})

// ── Horizontal containment ────────────────────────────────────────────────────

describe('tool-family horizontal containment contract', () => {
  it.each([
    {
      label: 'tool row keeps an over-long name and summary inside the row width',
      run: () =>
        renderAndMeasureUnit(toolUnitDef, overflowingTool, makeContractCtx({ width: NARROW_WIDTH }))
    },
    {
      label: 'subagent row keeps an over-long name and phase inside the row width',
      run: () =>
        renderAndMeasureUnit(
          subagentUnitDef,
          overflowingSubagent,
          makeContractCtx({ width: NARROW_WIDTH })
        )
    },
    {
      // The payload wrap is measured against the row width; at a narrow width a
      // section that keeps its content on one line spills instead of wrapping.
      label: 'expanded payload row keeps both sections inside a narrow row width',
      run: () =>
        renderAndMeasureUnit(
          toolUnitDef,
          payloadTool,
          makeContractCtx({
            width: NARROW_WIDTH,
            isCollapsed: (candidate) => candidate === payloadTool.id
          })
        )
    }
  ])('$label', async ({ label, run }) => {
    const reading = await run()
    measuredRows += 1
    renderedElements += reading.renderedElements
    expectHeightMatch(label, reading)
    expect(
      reading.spill,
      `${label}: spilled ${reading.spill}px past the ${NARROW_WIDTH}px row width`
    ).toBeLessThanOrEqual(0.5)
  })
})

// ── Subagent failure reason is on the row, not only in a tooltip ──────────────

describe('a failed subagent says why on the row', () => {
  // owner 在真机上截到的是「● Agent 失败」四个字 —— 失败了,原因一个字看不到。
  // 当时原因只写进 `title` 悬浮提示,而那个提示本身还永远是空的
  // (`subagentFromItem` 读的 `item.error` 在 ACP 的类型里根本不存在)。
  // presenter 那一半由 rows/tools/tool-args-4981.test.ts 判;这条判**渲染**那一半:
  // 原因必须真的出现在行上,而且不能把行撑高(subagentRoot 定高且 clip,撑高 = 被裁掉)。
  it('renders the reason inline without growing the clipped row', async () => {
    const reading = await renderAndMeasureUnit(
      subagentUnitDef,
      failedSubagent,
      makeContractCtx({ width: WIDTH }),
      (host) => {
        const chip = host.querySelector<HTMLElement>('[data-slot="tool-call-error"]')
        const header = host.querySelector<HTMLElement>(`.${subagentHeader}`)
        // ContractInspector 只收 Record<string, number>,所以文本比对在这里折成 0/1
        // 而不是把原文带出去(tsgo 会判红,vitest 不做类型检查照样绿)。
        return {
          chipFound: chip ? 1 : 0,
          chipSaysTheReason:
            chip?.textContent?.trim() === 'subagent exited non-zero' ? 1 : 0,
          chipHeight: chip?.offsetHeight ?? 0,
          headerHeight: header?.offsetHeight ?? 0
        }
      }
    )
    measuredRows += 1
    renderedElements += reading.renderedElements
    expectHeightMatch('subagent row (failure reason)', reading)

    const { chipFound, chipSaysTheReason, chipHeight, headerHeight } = reading.inspected
    expect(chipFound, '失败行没有把原因渲染出来 —— 又退回只有「失败」两个字').toBe(1)
    // 片里是**那条原因**,不是随便什么字 —— 否则渲染一个空片也能骗过 chipFound。
    expect(chipSaysTheReason, '片渲染出来了,但里面不是 provider 报的那条原因').toBe(1)
    // 片必须装得进定高的行里:装不下就被 overflow:hidden 裁掉,而 offsetHeight
    // 仍然读出那个「正确」的行高,高度类判据一条都不会红。
    expect(
      chipHeight,
      `原因片 ${chipHeight}px 装在 ${headerHeight}px 的行里,超出的部分会被静默裁掉`
    ).toBeLessThanOrEqual(headerHeight)
    expect(chipHeight).toBeGreaterThan(0)
  })
})

// ── Subagent header geometry inside the clipped row ───────────────────────────

describe('subagent header fills its measured row exactly', () => {
  // Same blind-spot class the child-stack reading below covers, on the other row:
  // `subagentRoot` is given an explicit height AND `overflow: hidden`, so a header
  // that renders taller than the row is silently clipped and `offsetHeight` still
  // reads the measured value. Every height contract above therefore stays green.
  //
  // Proven, not assumed: +1px on the header div's own inline height (Subagent.tsx,
  // the consumer) leaves all 39 other readings green. Note this is orthogonal to
  // the height contracts, which catch +1px at the SOURCE (subagent.def.tsx) where
  // root and header move together.
  it('renders the header at the row height rather than being clipped to it', async () => {
    const reading = await renderAndMeasureUnit(
      subagentUnitDef,
      runningSubagent,
      makeContractCtx({ width: WIDTH }),
      (host) => {
        const header = host.querySelector<HTMLElement>(`.${subagentHeader}`)
        return {
          headerFound: header ? 1 : 0,
          headerHeight: header?.offsetHeight ?? 0
        }
      }
    )
    measuredRows += 1
    renderedElements += reading.renderedElements
    expectHeightMatch('subagent row (header geometry)', reading)

    const { headerFound, headerHeight } = reading.inspected
    // Liveness: the inspector must have found the element it claims to measure.
    expect(headerFound, 'inspector found no subagent header to measure').toBe(1)
    expect(
      headerHeight,
      `subagent header rendered ${headerHeight}px inside a ${reading.computed}px row; a header taller than the row is clipped, not visible`
    ).toBe(reading.computed)
  })
})

// ── Child stack geometry inside the clamped preview ───────────────────────────

describe('tool-group collapsed preview keeps its child stack at content height', () => {
  // Blind spot this covers: once the preview clamps to `windowH`, the root's
  // border-box height is a constant (header + 180) no matter what the children
  // inside it do. Every height contract above therefore stays green while the
  // stack is wrong. `childrenHeight()` — the number the engine reserves and
  // scroll-anchors against — is only observable from inside.
  //
  // Proven, not assumed: dropping the inter-child gap on the render side alone
  // reads 384px here against the 428px the engine predicted, and leaves all 12
  // height contracts green.
  it('renders 12 children at full content height inside the 180px window', async () => {
    const reading = await renderAndMeasureUnit(
      toolGroupUnitDef,
      cappedToolGroup,
      makeContractCtx({ width: WIDTH }),
      (host) => {
        const stack = host.querySelector<HTMLElement>(`.${toolGroupChildStack}`)
        const rows = stack ? Array.from(stack.children) : []
        return {
          stackHeight: stack?.offsetHeight ?? 0,
          rowCount: rows.length,
          shortestRow: rows.length
            ? Math.min(...rows.map((row) => (row as HTMLElement).offsetHeight))
            : 0
        }
      }
    )
    measuredRows += 1
    renderedElements += reading.renderedElements
    expectHeightMatch('tool-group row (collapsed preview, clamped)', reading)

    const { rowCount, shortestRow, stackHeight } = reading.inspected
    // Liveness: the inspector must have found the stack it claims to measure.
    expect(rowCount, 'inspector found no child rows to measure').toBe(
      cappedToolGroup.children.length
    )
    expect(
      shortestRow,
      `a preview child rendered ${shortestRow}px tall; children must keep their measured row height and be clipped, not resized`
    ).toBe(ROW_H)
    expect(
      stackHeight,
      `child stack rendered ${stackHeight}px; it must equal the childrenHeight() the engine reserved for it`
    ).toBe(cappedToolGroup.children.length * ROW_H + (cappedToolGroup.children.length - 1) * CHILD_GAP)
  })
})

// ── Tool payload panel ────────────────────────────────────────────────────────

describe('tool row request / result payload panel', () => {
  it('reserves nothing for the panel while collapsed', async () => {
    const reading = await renderAndMeasureUnit(
      toolUnitDef,
      payloadTool,
      makeContractCtx({ width: WIDTH })
    )
    measuredRows += 1
    renderedElements += reading.renderedElements
    expectHeightMatch('tool row (payload, collapsed)', reading)
    // A payload-bearing row collapsed reads exactly like a payload-free one.
    // Without this the panel could be reserved in both states and the expanded
    // reading below would still be green.
    expect(
      reading.computed,
      'a collapsed payload row must reserve exactly the header row height'
    ).toBe(ROW_H)
  })

  // The blind spot here is the same one the subagent-header and child-stack
  // contracts above cover, on a third row: `toolRoot` carries an explicit height
  // AND `overflow: hidden`, so a panel that renders taller or shorter than it was
  // measured is silently clipped and the row's own offsetHeight still reads the
  // measured value. Every height contract stays green while the panel is wrong.
  // Only a reading taken from inside the row can tell them apart.
  it('renders both sections at exactly the height the engine reserved', async () => {
    const reading = await renderAndMeasureUnit(
      toolUnitDef,
      payloadTool,
      expandedCtx(payloadTool.id),
      (host) => {
        const sections = Array.from(
          host.querySelectorAll<HTMLElement>('[data-slot^="tool-call-re"]')
        )
        const request = host.querySelector<HTMLElement>('[data-slot="tool-call-request"]')
        const header = host.querySelector<HTMLElement>('[data-slot="tool-call-trigger"]')
        return {
          sectionCount: sections.length,
          sectionHeightSum: sections.reduce((sum, el) => sum + el.offsetHeight, 0),
          // 1 when the request is painted above the result, as the arguments
          // of a call have to be to read as its arguments.
          requestFirst: sections[0]?.dataset.slot === 'tool-call-request' ? 1 : 0,
          headerHeight: header?.offsetHeight ?? 0,
          requestContentHeight: request?.scrollHeight ?? 0,
          requestClientWidth: request?.clientWidth ?? 0,
          requestScrollWidth: request?.scrollWidth ?? 0,
          expandedTrue: host.querySelectorAll('[aria-expanded="true"]').length
        }
      }
    )
    measuredRows += 1
    renderedElements += reading.renderedElements
    expectHeightMatch('tool row (payload, expanded)', reading)

    const {
      expandedTrue,
      headerHeight,
      requestClientWidth,
      requestContentHeight,
      requestFirst,
      requestScrollWidth,
      sectionCount,
      sectionHeightSum
    } = reading.inspected

    // Liveness: the inspector must have found what it claims to measure.
    expect(sectionCount, 'inspector found no payload sections to measure').toBe(2)
    expect(requestFirst, 'the result is painted above the request').toBe(1)
    // The collapsed reading asserts aria-expanded="false"; without this one a
    // binding frozen at mount would satisfy both.
    expect(expandedTrue, 'an open row still reports aria-expanded="false"').toBe(1)

    expect(
      reading.computed,
      'an expanded payload row must reserve more than the bare header row'
    ).toBeGreaterThan(ROW_H)
    expect(
      headerHeight,
      `header rendered ${headerHeight}px; expanding the panel must not move the header off its fixed row height`
    ).toBe(ROW_H)
    expect(
      sectionHeightSum,
      `panel rendered ${sectionHeightSum}px inside a row that reserved ${reading.computed - ROW_H}px for it`
    ).toBe(reading.computed - ROW_H)

    // The request is one very long JSON line. Asserting only "no horizontal
    // overflow" would also be satisfied by an implementation that truncated it,
    // so require that it really occupies more than one visual line.
    expect(
      requestContentHeight,
      `request content rendered ${requestContentHeight}px — a single ${CODE_LINE_H}px line, so the long request was cut rather than wrapped`
    ).toBeGreaterThan(CODE_LINE_H)
    expect(
      requestScrollWidth,
      `request overflows its own box (scrollWidth ${requestScrollWidth} > clientWidth ${requestClientWidth})`
    ).toBeLessThanOrEqual(requestClientWidth + 1)
  })

  it('caps a very long section and keeps the rest reachable by scrolling', async () => {
    const reading = await renderAndMeasureUnit(
      toolUnitDef,
      cappedPayloadTool,
      expandedCtx(cappedPayloadTool.id),
      (host) => {
        const result = host.querySelector<HTMLElement>('[data-slot="tool-call-result"]')
        return {
          found: result ? 1 : 0,
          clientHeight: result?.clientHeight ?? 0,
          scrollHeight: result?.scrollHeight ?? 0
        }
      }
    )
    measuredRows += 1
    renderedElements += reading.renderedElements
    expectHeightMatch('tool row (payload, capped)', reading)

    const { clientHeight, found, scrollHeight } = reading.inspected
    expect(found, 'inspector found no result section to measure').toBe(1)
    // Capped: the reserved box is smaller than the content...
    expect(
      clientHeight,
      `result section reserved ${clientHeight}px for ${PAYLOAD_MAX_LINES} capped lines`
    ).toBeLessThan(scrollHeight)
    // ...and the content is still all there, reachable by scrolling rather than cut.
    expect(
      scrollHeight,
      'the over-long result was truncated instead of made scrollable'
    ).toBeGreaterThanOrEqual(CAPPED_RESULT_LINES * CODE_LINE_H)
  })

  it('offers the disclosure control only on rows that have something to disclose', async () => {
    const withPayload = await renderAndMeasureUnit(
      toolUnitDef,
      payloadTool,
      makeContractCtx({ width: WIDTH }),
      (host) => ({
        collapseTargets: host.querySelectorAll('[data-collapse-id]').length,
        chevrons: host.querySelectorAll(`.${collapseChevron}`).length,
        expandedFalse: host.querySelectorAll('[aria-expanded="false"]').length
      })
    )
    const withoutPayload = await renderAndMeasureUnit(
      toolUnitDef,
      tool,
      makeContractCtx({ width: WIDTH }),
      (host) => ({
        collapseTargets: host.querySelectorAll('[data-collapse-id]').length,
        chevrons: host.querySelectorAll(`.${collapseChevron}`).length
      })
    )
    measuredRows += 2
    renderedElements += withPayload.renderedElements + withoutPayload.renderedElements

    // Positive control first: the reading below is only meaningful if the same
    // selectors do find the control when it is supposed to be there.
    expect(withPayload.inspected.collapseTargets, 'payload row is not wired to toggle').toBe(1)
    expect(withPayload.inspected.chevrons, 'payload row renders no chevron').toBe(1)
    expect(withPayload.inspected.expandedFalse, 'payload row does not report its state').toBe(1)

    expect(
      withoutPayload.inspected.collapseTargets,
      'a payload-free row is wired to a collapse it has nothing to show for'
    ).toBe(0)
    expect(
      withoutPayload.inspected.chevrons,
      'a payload-free row renders a chevron that reveals nothing'
    ).toBe(0)
  })
})

// ── Failure section (#3334 row 33) ────────────────────────────────────────────
//
// This row exists to make a failure *legible*, so geometry alone cannot judge
// it: an empty spacer of the right height satisfies every border-box reading in
// this file, and so does a failure section painted in the result's colour —
// which is precisely the state this section was added to end. The readings below
// are the ones that go red when the section degenerates back into what it
// replaced: the reason's own text, its own colour, and the absence of the native
// tooltip that used to be the only place that text could be found.
//
// Since 2026-09-04 the section is disclosed rather than painted (owner: an error
// must not open itself). That moved which state each reading is taken in, not
// what any of them judges — a hidden reason still has to be the reason, in the
// failure colour, reachable, and capped.
describe('tool row failure section', () => {
  // Two readings, because either alone is satisfied by a broken row: a row that
  // renders no failure section in *any* state passes the closed half, and a row
  // that paints the reason unconditionally passes the open half. Together they
  // say hidden-but-really-there-and-reachable, which is the actual rule.
  it('keeps the reason behind the chevron until the row is opened', async () => {
    const closed = await renderAndMeasureUnit(
      toolUnitDef,
      failedTool,
      makeContractCtx({ width: WIDTH }),
      (host) => {
        const header = host.querySelector<HTMLElement>('[data-slot="tool-call-trigger"]')
        return {
          // Positive control: this really is a failed row, so the zeros below
          // are readings about the section and not about a fixture that never
          // failed and therefore had no reason to show in the first place.
          markFound: host.querySelectorAll('[data-slot="tool-call-error-mark"]').length,
          errorSections: host.querySelectorAll('[data-slot="tool-call-error"]').length,
          otherSections: host.querySelectorAll('[data-slot^="tool-call-re"]').length,
          // Not just "no error slot": the reason must not be on screen at all,
          // in any slot. A row that moved it elsewhere would pass the slot count.
          statesTheReasonAnyway: host.textContent?.includes(REASON) ? 1 : 0,
          // ...and it has to be reachable, or hiding it is just losing it.
          collapseTargets: host.querySelectorAll('[data-collapse-id]').length,
          headerHeight: header?.offsetHeight ?? 0
        }
      }
    )
    const open = await renderAndMeasureUnit(
      toolUnitDef,
      failedTool,
      expandedCtx(failedTool.id),
      (host) => {
        const error = host.querySelector<HTMLElement>('[data-slot="tool-call-error"]')
        return {
          found: error ? 1 : 0,
          // The reason itself, not a box where a reason could go.
          statesTheReason: error?.textContent?.includes(REASON) ? 1 : 0,
          sectionHeight: error?.offsetHeight ?? 0
        }
      }
    )
    measuredRows += 2
    renderedElements += closed.renderedElements + open.renderedElements
    expectHeightMatch('tool row (failed, collapsed)', closed)
    expectHeightMatch('tool row (failed, opened)', open)

    expect(
      closed.inspected.markFound,
      'inspector found no error mark — every zero below would mean nothing'
    ).toBe(1)
    expect(
      closed.inspected.errorSections,
      'the failure opened itself; nobody asked it to'
    ).toBe(0)
    expect(
      closed.inspected.statesTheReasonAnyway,
      'the reason is on screen while closed, just not in the failure slot'
    ).toBe(0)
    expect(
      closed.inspected.otherSections,
      'a collapsed row disclosed its request or result'
    ).toBe(0)
    expect(closed.computed, 'a closed failed row reserved more than its header').toBe(ROW_H)
    expect(closed.inspected.headerHeight, 'the header is not the fixed row height').toBe(ROW_H)
    expect(
      closed.inspected.collapseTargets,
      'the reason is hidden and the row has no toggle — it is lost, not disclosed'
    ).toBe(1)

    expect(open.inspected.found, 'opening the row disclosed no failure section').toBe(1)
    expect(
      open.inspected.statesTheReason,
      'the opened section is a box where the reason should be'
    ).toBe(1)
    expect(
      open.computed,
      'an opened failed row still reserved only its header'
    ).toBeGreaterThan(ROW_H)
    expect(
      open.inspected.sectionHeight,
      `failure section rendered ${open.inspected.sectionHeight}px inside the ${open.computed - ROW_H}px the row reserved`
    ).toBe(open.computed - ROW_H)
  })

  it('paints the reason in the failure colour, not the result colour', async () => {
    const reading = await renderAndMeasureUnit(
      toolUnitDef,
      failedToolWithRequest,
      expandedCtx(failedToolWithRequest.id),
      (host) => {
        const line = (slot: string) =>
          host.querySelector<HTMLElement>(`[data-slot="tool-call-${slot}"] > *`)
        const errorLine = line('error')
        const resultLine = line('result')
        const mark = host.querySelector<HTMLElement>('[data-slot="tool-call-error-mark"]')
        const colour = (el: HTMLElement | null) => (el ? getComputedStyle(el).color : '')
        const errorColour = colour(errorLine)
        return {
          errorFound: errorLine ? 1 : 0,
          resultFound: resultLine ? 1 : 0,
          markFound: mark ? 1 : 0,
          // One statement in one colour: the mark in the status slot and the
          // text explaining it are the same token.
          matchesMark: errorColour !== '' && errorColour === colour(mark) ? 1 : 0,
          // ...and distinguishable from an ordinary answer, which is the whole
          // difference between this and what the row did before.
          differsFromResult: errorColour !== '' && errorColour !== colour(resultLine) ? 1 : 0
        }
      }
    )
    measuredRows += 1
    renderedElements += reading.renderedElements
    expectHeightMatch('tool row (failed, expanded)', reading)

    const { differsFromResult, errorFound, markFound, matchesMark, resultFound } = reading.inspected

    // Positive controls first: all three elements the colour reading compares
    // must actually have been found, or "the colours differ" is a statement
    // about two empty strings.
    expect(errorFound, 'inspector found no failure line to sample').toBe(1)
    expect(resultFound, 'inspector found no result line to contrast against').toBe(1)
    expect(markFound, 'inspector found no error mark to contrast against').toBe(1)

    expect(matchesMark, 'the failure text is not the colour of the mark that announces it').toBe(1)
    expect(
      differsFromResult,
      'the failure reads in the same colour as an ordinary result — indistinguishable from success'
    ).toBe(1)
  })

  it('leaves no native tooltip carrying what the row now says out loud', async () => {
    const reading = await renderAndMeasureUnit(
      toolUnitDef,
      failedTool,
      makeContractCtx({ width: WIDTH }),
      (host) => {
        const mark = host.querySelector<HTMLElement>('[data-slot="tool-call-error-mark"]')
        return {
          // Positive control: the element that used to carry `title` is found,
          // so the zero below is a reading about that element and not about a
          // selector that matched nothing.
          markFound: mark ? 1 : 0,
          markNamed: mark?.getAttribute('aria-label') ? 1 : 0,
          markTitles: mark?.hasAttribute('title') ? 1 : 0,
          rowTitles: host.querySelectorAll('[title]').length
        }
      }
    )
    measuredRows += 1
    renderedElements += reading.renderedElements

    const { markFound, markNamed, markTitles, rowTitles } = reading.inspected
    expect(markFound, 'inspector found no error mark — the zeros below mean nothing').toBe(1)
    // The accessible name stays; it is read out rather than hovered.
    expect(markNamed, 'the error mark lost its accessible name along with its tooltip').toBe(1)
    expect(markTitles, 'the error mark still carries a native tooltip').toBe(0)
    expect(rowTitles, 'something in the row still carries a native tooltip').toBe(0)
  })

  it('caps a long trace at the panel cap and keeps the rest scrollable', async () => {
    const reading = await renderAndMeasureUnit(
      toolUnitDef,
      stackFailedTool,
      // Expanded: closed there is no trace on screen, so the cap would be a
      // statement about a section that was never rendered.
      expandedCtx(stackFailedTool.id),
      (host) => {
        const error = host.querySelector<HTMLElement>('[data-slot="tool-call-error"]')
        return {
          found: error ? 1 : 0,
          clientHeight: error?.clientHeight ?? 0,
          scrollHeight: error?.scrollHeight ?? 0
        }
      }
    )
    measuredRows += 1
    renderedElements += reading.renderedElements
    expectHeightMatch('tool row (failed, capped trace)', reading)

    const { clientHeight, found, scrollHeight } = reading.inspected
    expect(found, 'inspector found no failure section to measure').toBe(1)
    // The exact number, not "clientHeight < scrollHeight": the loose form is
    // satisfied by any cap at all, including the tighter one this section used
    // to answer to — and that one is now the wrong answer, not a stricter one.
    expect(
      clientHeight,
      `failure section reserved ${clientHeight}px; ${PAYLOAD_MAX_LINES} lines is ${PAYLOAD_MAX_LINES * CODE_LINE_H}px`
    ).toBe(PAYLOAD_MAX_LINES * CODE_LINE_H)
    expect(
      scrollHeight,
      'the trace was truncated instead of made scrollable'
    ).toBeGreaterThanOrEqual(FAILURE_TRACE_LINES * CODE_LINE_H)
  })

  it('grows the chevron that the hidden reason has to be reachable through', async () => {
    const read = (host: HTMLElement) => ({
      chevrons: host.querySelectorAll(`.${collapseChevron}`).length,
      collapseTargets: host.querySelectorAll('[data-collapse-id]').length,
      markFound: host.querySelectorAll('[data-slot="tool-call-error-mark"]').length
    })
    const failureOnly = await renderAndMeasureUnit(
      toolUnitDef,
      failedTool,
      makeContractCtx({ width: WIDTH }),
      read
    )
    // Negative control: a row whose provider reported nothing at all. Without
    // it "the row has a chevron" would be satisfied by a build that puts one on
    // every row, which judges nothing.
    const nothingToShow = await renderAndMeasureUnit(
      toolUnitDef,
      tool,
      makeContractCtx({ width: WIDTH }),
      read
    )
    measuredRows += 2
    renderedElements += failureOnly.renderedElements + nothingToShow.renderedElements

    expect(
      failureOnly.inspected.markFound,
      'the failure-only fixture rendered as a row that never failed'
    ).toBe(1)
    expect(
      failureOnly.inspected.chevrons,
      'the reason is behind a disclosure the row never grew — unreachable'
    ).toBe(1)
    expect(failureOnly.inspected.collapseTargets, 'that row is not wired to toggle').toBe(1)

    expect(
      nothingToShow.inspected.chevrons,
      'a row with nothing to reveal still offers to reveal it'
    ).toBe(0)
    expect(
      nothingToShow.inspected.collapseTargets,
      'that row is wired to a toggle with nothing behind it'
    ).toBe(0)
  })
})

afterAll(() => {
  // Liveness controls for the measuring instrument. Zero means the browser
  // collector or the renderer is broken, not that the geometry is clean.
  expect(measuredRows, 'tool-family contract measured zero rows').toBeGreaterThan(0)
  expect(renderedElements, 'tool-family contract rendered zero DOM elements').toBeGreaterThan(0)
})


/**
 * #4981 —— 右侧那一格只留**需要读者看一眼**的记号（owner 2026-09-05 拍板去掉绿勾）。
 *
 * 上游两个 element 在这一格上说的不是一件事：`elements-tool-call` 是「a checkmark once
 * it settles」，`elements-tool-timeline` 每一步只有 icon + verb + chip、**没有对勾**，
 * 靠「只有最后一步在 streaming 时微光」表达状态。gugu 的工具行两个身份都当，只能取一个。
 *
 * ⚠️ 「做完的行没有记号」这句话单独立不住：探针选错元素时它同样为真。所以前三条共用
 * **同一个探针**、只改 `status` 这一个自由度 —— 出错与等授权那两条就是它的阳控，证明这个
 * 探针确实找得到记号。第四条守的是另一件事：去掉绿勾之后「做完了」还有东西表达
 * （没有微光），而不是把「跑着」和「做完」抹成同一个样子。
 */
describe('#4981 状态记号只留需要看一眼的那些', () => {
  /** 记号一律是 svg；行首那个 `›` 是文本，不会混进来。 */
  const marksIn = (host: HTMLElement): Record<string, number> => {
    const trigger = host.querySelector<HTMLElement>('[data-slot="tool-call-trigger"]')
    return {
      marks: trigger ? trigger.querySelectorAll('svg').length : 0,
      triggerFound: trigger ? 1 : 0
    }
  }

  const readMarks = async (item: ChatToolCall) =>
    (await renderAndMeasureUnit(toolUnitDef, item, makeContractCtx({ width: WIDTH }), marksIn))
      .inspected

  it('做完的行不画记号', async () => {
    const r = await readMarks(tool)
    expect(r.triggerFound, '探针没找到行头，下面那个 0 是仪器坏了、不是读数').toBe(1)
    expect(r.marks).toBe(0)
  })

  it('阳控：出错的行仍然画记号 —— 同一个探针，只差 status 一个自由度', async () => {
    expect((await readMarks(erroredTool)).marks).toBe(1)
  })

  it('阳控：等授权的行仍然画记号', async () => {
    expect((await readMarks(awaitingTool)).marks).toBe(1)
  })

  it('跑着的行靠名字微光说话 —— 「做完了」= 没有微光，不是没有任何区别', async () => {
    const shimmerOf = (host: HTMLElement): Record<string, number> => {
      const label = host.querySelector<HTMLElement>(`.${toolName}`)
      return {
        labelFound: label ? 1 : 0,
        transparentFill:
          label && getComputedStyle(label).webkitTextFillColor === 'rgba(0, 0, 0, 0)' ? 1 : 0
      }
    }
    const running = (
      await renderAndMeasureUnit(toolUnitDef, runningTool, makeContractCtx({ width: WIDTH }), shimmerOf)
    ).inspected
    const done = (
      await renderAndMeasureUnit(toolUnitDef, tool, makeContractCtx({ width: WIDTH }), shimmerOf)
    ).inspected
    expect(running.labelFound, '探针没找到名字那一格').toBe(1)
    expect(running.transparentFill, '跑着的行也没有微光 ⇒ 两个状态长得一模一样').toBe(1)
    expect(done.transparentFill).toBe(0)
  })
})
