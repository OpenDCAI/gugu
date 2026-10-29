/** @jsxImportSource solid-js */
import { textFilePatch } from '@gugu/session-core/lib';

import { compactionUnitDef } from '@session-chat/components/rows/boundary/compaction.def'
import { contextResetUnitDef } from '@session-chat/components/rows/boundary/context-reset.def'
import { daySeparatorUnitDef } from '@session-chat/components/rows/day-separator/day-separator.def'
import { codeBlockDef } from '@session-chat/components/rows/markdown/code/code.def'
import { htmlBlockDef } from '@session-chat/components/rows/markdown/html/html.def'
import { mathBlockDef } from '@session-chat/components/rows/markdown/math/math.def'
import { messageUnitDef } from '@session-chat/components/rows/message/message.def'
import { planUnitDef } from '@session-chat/components/rows/plan/plan.def'
import { resourceLinkUnitDef } from '@session-chat/components/rows/resource-link/resource-link.def'
import { thinkingUnitDef } from '@session-chat/components/rows/thinking/thinking.def'
import { turnOutcomeUnitDef } from '@session-chat/components/rows/turn-outcome/turn-outcome.def'
import { diffUnitDef } from '@session-chat/components/rows/tools/diff/diff.def'
import { executeUnitDef } from '@session-chat/components/rows/tools/execute/execute.def'
import { fileOpUnitDef } from '@session-chat/components/rows/tools/file-op/file-op.def'
import type { Block, HtmlBlock } from '@session-chat/core/markdown/document'
import { parseMarkdownToBlocks } from '@session-chat/core/markdown/parse'
import type {
  ChatDiff,
  ChatExecute,
  ChatFileOpToolCall,
  ChatMessage,
  ChatPlan,
  ChatResourceLink,
  ChatThinking,
  DaySeparatorItem,
  TurnOutcomeItem
} from '@session-chat/model'
import { afterAll, describe, expect, it } from 'vitest'
import {
  makeContractCtx,
  renderAndMeasureBlock,
  renderAndMeasureUnit,
  type ContractCtx,
  type ContractInspector,
  type HeightContractReading
} from './contract'

const WIDTH = 420

let measuredRows = 0
let measuredBlockTiers = 0
let renderedElements = 0

function expectHeightMatch(layer: string, reading: HeightContractReading): void {
  const delta = reading.dom - reading.computed
  expect(
    reading.dom,
    `${layer} height mismatch: engine=${reading.computed}px DOM=${reading.dom}px delta=${delta}px`
  ).toBe(reading.computed)
}

const assistantMessage: ChatMessage = {
  kind: 'message',
  id: 'contract-message',
  role: 'assistant',
  text: Array.from({ length: 12 }, (_, index) => `\`chip${index}\``).join(' ')
}

// #7333: the user card at the 16/24 body, mixed CJK / Latin with inline code, long enough to wrap at both widths.
const userMessageMixed: ChatMessage = {
  kind: 'message',
  id: 'contract-user-mixed',
  role: 'user',
  text: '请把这段中文和 English 混排的消息量准:里面有 `inlineCode()`、@file.ts 和 /deploy,宽度变了也要一起换行。'
}

const thinking: ChatThinking = {
  kind: 'thinking',
  id: 'contract-thinking',
  status: 'done',
  text: 'First measured thought line.\n\nSecond measured thought line.',
  startedAt: 0,
  durationMs: 1_200
}

const diff: ChatDiff = {
  kind: 'diff',
  id: 'contract-diff',
  patches: [textFilePatch('src/height.ts', 'const height = 20;\nreturn height;', 'const height = 21;\nreturn height;\n// measured')],

  status: 'done'
}

const execute: ChatExecute = {
  kind: 'execute',
  id: 'contract-execute',
  command: 'pnpm test:unit',
  outputText: 'contract collected\ncontract passed',
  status: 'done',
  startedAt: 0,
  durationMs: 500
}

const fileOp: ChatFileOpToolCall = {
  kind: 'file-op',
  id: 'contract-file-op',
  op: 'edit',
  status: 'done',
  ops: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/c.ts' }]
}

const plan: ChatPlan = {
  kind: 'plan',
  id: 'contract-plan',
  entries: [
    { content: 'Measure the rendered row', status: 'completed', priority: 'high' },
    { content: 'Compare the exact heights', status: 'in_progress', priority: 'medium' }
  ]
}

// Long enough that listHeight exceeds PlanVars.windowH, so the collapsed
// reading exercises the Math.min clamp and the PreviewWindow branch rather
// than re-testing the same short list the expanded case already covers.
const cappedPlan: ChatPlan = {
  kind: 'plan',
  id: 'contract-plan-capped',
  entries: Array.from({ length: 9 }, (_, index) => ({
    content: `Plan entry ${index} kept on one line`,
    status: index === 0 ? ('completed' as const) : ('pending' as const),
    priority: 'medium' as const
  }))
}

const resourceLink: ChatResourceLink = {
  kind: 'resource-link',
  id: 'contract-resource-link',
  uri: 'file:///repo/src/height.ts',
  name: 'height.ts',
  size: 2048,
  target: { kind: 'workspace-file', path: 'src/height.ts' }
}

const opaqueResourceLink: ChatResourceLink = {
  kind: 'resource-link',
  id: 'contract-resource-link-opaque',
  uri: 'acp://opaque/resource',
  name: 'opaque resource',
  target: { kind: 'opaque' }
}

// Both text cells are far wider than the host, so an ellipsis rule that stops
// working shows up as a spill rather than as a silently clipped row.
const overflowingResourceLink: ChatResourceLink = {
  kind: 'resource-link',
  id: 'contract-resource-link-overflow',
  uri: `file:///repo/${'deeply-nested-directory/'.repeat(8)}component.tsx`,
  name: `${'extremely-long-resource-file-name-'.repeat(4)}component.tsx`,
  size: 1_048_576,
  target: {
    kind: 'workspace-file',
    path: `${'deeply-nested-directory/'.repeat(8)}component.tsx`
  }
}

// turn-outcome: the same settled row with and without the host-wired restore
// action. #3498 adds a control to a row whose measure() is the constant ROW_H,
// so the pair is the whole point — if the button moved the geometry, the two
// readings would disagree with each other or with measure().
const bareOutcome: TurnOutcomeItem = {
  kind: 'turn-outcome',
  turnId: 'turn-bare',
  id: 'contract-turn-outcome',
  outcome: { kind: 'error', reason: 'prompt_failed' }
}

/** 出错 + 有指令 ⇒ 「取回指令」会渲染。`bareOutcome` 没有 prompt，那一支本来就不画按钮。 */
const bareOutcomeWithPrompt: TurnOutcomeItem = {
  kind: 'turn-outcome',
  turnId: 'turn-error-prompted',
  id: 'contract-turn-outcome-error-prompted',
  outcome: { kind: 'error', reason: 'prompt_failed' },
  prompt: 'Translate README.md into English and keep the code fences intact'
}

const actionableOutcome: TurnOutcomeItem = {
  kind: 'turn-outcome',
  turnId: 'turn-actionable',
  id: 'contract-turn-outcome-action',
  outcome: { kind: 'cancelled', reason: 'cancelled' },
  prompt: 'Translate README.md into English and keep the code fences intact'
}

/**
 * 宿主把收尾行**两颗**动作都接上的形状 —— 这就是被停止那一轮在生产里的真样子。
 * ⚠️ 只接 `onRestorePrompt` 时「继续」在结构上不渲染（回调即开关），于是这条契约会**平凡地绿**：
 * 它根本没量到那颗按钮。两颗一起接才是这一族里最高最宽的那一行。
 */
const outcomeActionCommands = { onRestorePrompt: () => {}, onContinueTurn: () => {} }

// day-separator: measure() is a constant, and the label is the only thing in the
// row whose width depends on data. A date old enough to be rendered in the
// absolute `MMM d yyyy` form is deliberately chosen — that is the WIDEST of the
// three label forms, so the containment reading below is taken on the worst case
// and not on a two-character "Today".
const daySeparator: DaySeparatorItem = {
  kind: 'day-separator',
  id: 'contract-day-separator',
  startedAt: new Date(2024, 2, 3, 9, 41).getTime()
}

// 两种界线行（#5381）：measure() 都是常量，行里唯一随数据变的只有标签那句话，而标签是
// 固定文案。取**最长**的那一种状态（压缩完成那句最长）——量的是最坏情况，不是两个字的短态。
const compaction = {
  kind: 'compaction' as const,
  id: 'contract-compaction',
  seq: 0,
  compactionId: 'cmp_001',
  status: 'completed' as const,
  summary: '## 保留下来的上下文\n用户在改 schema。',
  startedAt: new Date(2024, 2, 3, 9, 41).getTime()
}

const contextReset = {
  kind: 'context-reset' as const,
  id: 'contract-context-reset',
  seq: 0,
  reason: 'Session not found: sess_abc',
  at: new Date(2024, 2, 3, 9, 41).getTime()
}

const expandedCtx = (id: string): ContractCtx =>
  makeContractCtx({ width: WIDTH, isCollapsed: (candidate) => candidate === id })

describe('row measure to rendered border-box height contract', () => {
  it.each([
    {
      label: 'message row',
      run: () =>
        renderAndMeasureUnit(messageUnitDef, assistantMessage, makeContractCtx({ width: 101 }))
    },
    {
      label: 'user message row, mixed CJK, narrow',
      run: () => renderAndMeasureUnit(messageUnitDef, userMessageMixed, makeContractCtx({ width: 180 }))
    },
    {
      label: 'user message row, mixed CJK, wide',
      run: () => renderAndMeasureUnit(messageUnitDef, userMessageMixed, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'thinking row',
      run: () => renderAndMeasureUnit(thinkingUnitDef, thinking, expandedCtx(thinking.id))
    },
    {
      label: 'diff row',
      run: () => renderAndMeasureUnit(diffUnitDef, diff, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'execute row',
      run: () => renderAndMeasureUnit(executeUnitDef, execute, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'file-op row',
      run: () => renderAndMeasureUnit(fileOpUnitDef, fileOp, expandedCtx(fileOp.id))
    },
    {
      label: 'plan row',
      run: () => renderAndMeasureUnit(planUnitDef, plan, expandedCtx(plan.id))
    },
    {
      label: 'plan row (collapsed preview)',
      run: () => renderAndMeasureUnit(planUnitDef, cappedPlan, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'resource-link row',
      run: () =>
        renderAndMeasureUnit(resourceLinkUnitDef, resourceLink, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'resource-link row (opaque target)',
      run: () =>
        renderAndMeasureUnit(
          resourceLinkUnitDef,
          opaqueResourceLink,
          makeContractCtx({ width: WIDTH })
        )
    },
    {
      label: 'turn-outcome row (no host action)',
      run: () =>
        renderAndMeasureUnit(turnOutcomeUnitDef, bareOutcome, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'turn-outcome row (restore action wired)',
      run: () =>
        renderAndMeasureUnit(
          turnOutcomeUnitDef,
          actionableOutcome,
          makeContractCtx({ width: WIDTH }),
          undefined,
          outcomeActionCommands
        )
    },
    {
      label: 'day-separator row',
      run: () =>
        renderAndMeasureUnit(daySeparatorUnitDef, daySeparator, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'compaction row',
      run: () =>
        renderAndMeasureUnit(compactionUnitDef, compaction, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'context-reset row',
      run: () =>
        renderAndMeasureUnit(contextResetUnitDef, contextReset, makeContractCtx({ width: WIDTH }))
    }
  ])('$label', async ({ label, run }) => {
    const reading = await run()
    measuredRows += 1
    renderedElements += reading.renderedElements
    expectHeightMatch(label, reading)
  })
})

describe('resource-link horizontal containment contract', () => {
  // The row carries no border now, so nothing visually marks its right edge:
  // a broken ellipsis rule would push the path straight into the next column
  // and still read as an ordinary long line. This is the sentinel for that.
  it('keeps an over-long name and path inside the row width', async () => {
    const reading = await renderAndMeasureUnit(
      resourceLinkUnitDef,
      overflowingResourceLink,
      makeContractCtx({ width: 180 })
    )
    measuredRows += 1
    renderedElements += reading.renderedElements
    expectHeightMatch('resource-link row (overflowing)', reading)
    expect(
      reading.spill,
      `resource-link spilled ${reading.spill}px past the 180px row width`
    ).toBeLessThanOrEqual(0.5)
  })
})

describe('turn-outcome action containment contract', () => {
  // The row root is given an explicit `height: ROW_H` and measure() returns that
  // same constant, so the border-box check above CANNOT see a control that is
  // too tall: the root stays 32px and the button just hangs out of it, over the
  // next row. The only reading that separates those two worlds comes from inside
  // the row — hence the inspector.
  //
  // The padding reading is here for a second reason: reset.css.ts ships an
  // UNLAYERED `button { padding: 0 }` whose scope is the whole host document
  // (#3490). "A vanilla-extract class selector outranks a tag selector" is an
  // inference; this turns it into a measurement, so the day that reset changes,
  // this row's button does not silently collapse into its own text.
  //
  // ⚠️ 三颗控件走同一条判据，用循环而不是复制粘贴：#5073 之后这一行按收尾态分成两副面孔
  // （被停止 = 上游的「继续 / 丢弃」；出错 = 本仓的「取回指令」），一份一份手抄下去，
  // 漏掉哪一颗都看不出来。
  async function readControls(
    item: TurnOutcomeItem,
    slots: readonly string[]
  ): Promise<{ reading: HeightContractReading; read: Record<string, number> }> {
    const reading = await renderAndMeasureUnit(
      turnOutcomeUnitDef,
      item,
      makeContractCtx({ width: WIDTH }),
      (host) => {
        const row = host.querySelector<HTMLElement>('[data-slot="turn-outcome"]')
        // 计数总会落地；几何键在读不到元素时**整个缺席**，于是漏掉的选择器读成 `undefined`
        // （响亮地失败），而不是一个看起来像读数的 0。
        const out: Record<string, number> = { rowCount: row ? 1 : 0 }
        if (!row) return out
        const rowRect = row.getBoundingClientRect()
        for (const slot of slots) {
          const el = host.querySelector<HTMLElement>(`[data-slot="${slot}"]`)
          out[`${slot}:count`] = el ? 1 : 0
          if (!el) continue
          const rect = el.getBoundingClientRect()
          out[`${slot}:height`] = rect.height
          // Positive = the control pokes out of the row's measured band.
          out[`${slot}:overflowTop`] = rowRect.top - rect.top
          out[`${slot}:overflowBottom`] = rect.bottom - rowRect.bottom
          out[`${slot}:paddingInline`] = Number.parseFloat(getComputedStyle(el).paddingLeft)
        }
        return out
      },
      outcomeActionCommands
    )
    measuredRows += 1
    renderedElements += reading.renderedElements
    return { reading, read: reading.inspected }
  }

  function expectContained(
    read: Record<string, number>,
    reading: HeightContractReading,
    slot: string
  ) {
    expect(read[`${slot}:count`], `${slot} is not in the DOM`).toBe(1)
    expect(read[`${slot}:height`], `${slot} collapsed to nothing`).toBeGreaterThan(0)
    expect(
      read[`${slot}:height`],
      `${slot} is ${read[`${slot}:height`]}px tall inside a ${reading.computed}px row`
    ).toBeLessThanOrEqual(reading.computed)
    expect(
      read[`${slot}:overflowTop`],
      `${slot} pokes ${read[`${slot}:overflowTop`]}px above the row`
    ).toBeLessThanOrEqual(0.5)
    expect(
      read[`${slot}:overflowBottom`],
      `${slot} pokes ${read[`${slot}:overflowBottom`]}px below the row — it will sit on top of the next one`
    ).toBeLessThanOrEqual(0.5)
    expect(
      read[`${slot}:paddingInline`],
      `the unlayered button padding reset ate ${slot}'s padding`
    ).toBeGreaterThan(0)
  }

  it('被停止那一行：上游的「继续」「丢弃」都留在量过的高度里', async () => {
    const { reading, read } = await readControls(actionableOutcome, [
      'turn-outcome-continue',
      'turn-outcome-discard'
    ])
    expect(read.rowCount, 'the turn-outcome row is not in the DOM').toBe(1)
    expectHeightMatch('turn-outcome row (cancelled, inspected)', reading)
    expectContained(read, reading, 'turn-outcome-continue')
    expectContained(read, reading, 'turn-outcome-discard')
    expect(
      reading.spill,
      `the cancelled lane spilled ${reading.spill}px past the row width`
    ).toBeLessThanOrEqual(0.5)
  })

  it('被停止那一行：上游 lane 那段空白在（按钮才被顶到右边），且不画失败那条线', async () => {
    const { read } = await readControls(actionableOutcome, [
      'turn-outcome-spacer',
      'turn-outcome-rule',
      'turn-outcome-action'
    ])
    expect(read['turn-outcome-spacer:count'], 'the cancelled row drew no ms-auto spacer').toBe(1)
    // 两条阴性对照：这一支就是上游那条 lane —— 既不画失败作用域的发丝线（把它停了不是失败），
    // 也不再画本仓自家的「取回指令」（那是 error-state 那一族的控件，塞进来就是顶掉上游的设计）。
    expect(read['turn-outcome-rule:count'], 'the cancelled row drew the failure-scope rule').toBe(0)
    expect(
      read['turn-outcome-action:count'],
      'the cancelled row still draws the restore action — upstream stopped-run has Continue/Discard there'
    ).toBe(0)
  })

  it('出错那一行：「取回指令」留在量过的高度里，且那条发丝线还在', async () => {
    const { reading, read } = await readControls(bareOutcomeWithPrompt, [
      'turn-outcome-action',
      'turn-outcome-rule',
      'turn-outcome-continue'
    ])
    expect(read.rowCount, 'the turn-outcome row is not in the DOM').toBe(1)
    expectHeightMatch('turn-outcome row (error, inspected)', reading)
    expectContained(read, reading, 'turn-outcome-action')
    expect(read['turn-outcome-rule:count'], 'the error row lost its failure-scope rule').toBe(1)
    // 阴性对照：「继续」只属于被停止那一支 —— 一轮已经失败的调用没有「接着往下」这回事。
    expect(read['turn-outcome-continue:count'], 'the error row drew a continue action').toBe(0)
  })
})

describe('day-separator containment contract', () => {
  // Same trap as turn-outcome: the row root is given an explicit `height` and
  // measure() returns that same constant, so the border-box check above CANNOT
  // see a label that outgrows the band — the root stays 24px and the text just
  // spills over the message under it. The only reading that separates those two
  // worlds comes from inside the row.
  //
  // The rule widths are read for a second reason: the two hairlines are the only
  // flexible children, so "the label got too wide" and "the rules collapsed to
  // nothing" are the same failure seen from opposite ends. A separator whose
  // rules are 0px wide is not a separator, and no height assertion can tell.
  it('keeps the label inside the row and leaves both rules visible', async () => {
    const reading = await renderAndMeasureUnit(
      daySeparatorUnitDef,
      daySeparator,
      makeContractCtx({ width: WIDTH }),
      (host) => {
        const row = host.querySelector<HTMLElement>('[data-slot="day-separator"]')
        const label = host.querySelector<HTMLElement>('[data-slot="day-separator-label"]')
        const rules = host.querySelectorAll<HTMLElement>('[data-slot="day-separator-rule"]')
        // Counts always land; the geometry keys are ABSENT when there is nothing
        // to measure, so a missed selector reads as `undefined` (a loud failure)
        // rather than as a tidy 0 that looks like a clean reading.
        const read: Record<string, number> = {
          rowCount: row ? 1 : 0,
          labelCount: label ? 1 : 0,
          ruleCount: rules.length
        }
        if (!row || !label || rules.length !== 2) return read
        const rowRect = row.getBoundingClientRect()
        const labelRect = label.getBoundingClientRect()
        read.labelHeight = labelRect.height
        read.labelWidth = labelRect.width
        // Positive = the label pokes out of the row's measured band.
        read.overflowTop = rowRect.top - labelRect.top
        read.overflowBottom = labelRect.bottom - rowRect.bottom
        read.leftRuleWidth = rules[0].getBoundingClientRect().width
        read.rightRuleWidth = rules[1].getBoundingClientRect().width
        return read
      }
    )
    measuredRows += 1
    renderedElements += reading.renderedElements

    const read = reading.inspected
    // Instrument liveness first: a missed selector and "the row is clean" are
    // the same shape in every assertion below it.
    expect(read.rowCount, 'the day-separator row is not in the DOM').toBe(1)
    expect(read.labelCount, 'the day label is not in the DOM').toBe(1)
    expect(read.ruleCount, 'the separator did not render exactly two hairlines').toBe(2)

    expectHeightMatch('day-separator row (inspected)', reading)
    expect(read.labelWidth, 'the day label rendered no text').toBeGreaterThan(0)
    expect(
      read.labelHeight,
      `the label is ${read.labelHeight}px tall inside a ${reading.computed}px row`
    ).toBeLessThanOrEqual(reading.computed)
    expect(read.overflowTop, `the label pokes ${read.overflowTop}px above the row`).toBeLessThanOrEqual(0.5)
    expect(
      read.overflowBottom,
      `the label pokes ${read.overflowBottom}px below the row — it will sit on top of the next one`
    ).toBeLessThanOrEqual(0.5)
    expect(read.leftRuleWidth, 'the left hairline collapsed to nothing').toBeGreaterThan(0)
    expect(read.rightRuleWidth, 'the right hairline collapsed to nothing').toBeGreaterThan(0)
    expect(reading.spill, `the separator spilled ${reading.spill}px past the row width`).toBeLessThanOrEqual(0.5)
  })
})

function textRun(id: string, markdown: string): HtmlBlock {
  const [block] = parseMarkdownToBlocks(id, markdown)
  if (block?.kind !== 'html') throw new Error(`expected one text run for ${id}`)
  return block
}

const blocks = [
  {
    label: 'text run tier',
    block: textRun('contract-text', 'Inline `heightContract` followed by enough text to wrap at the contract width.')
  },
  {
    label: 'code block tier',
    block: {
      kind: 'code',
      id: 'contract-block#1',
      lang: 'typescript',
      code: 'const predicted = def.measure(item, ctx).height;\nexpect(predicted).toBe(dom);'
    }
  },
  {
    label: 'text run tier (table)',
    block: textRun(
      'contract-table',
      '| Layer | Height |\n| --- | --- |\n| engine prediction | measured |\n| rendered DOM | offsetHeight |'
    )
  },
  {
    // Display math is the one tier whose height comes from really typesetting
    // the content rather than from a formula over line counts, so it is also
    // the one tier where "predicted" and "rendered" could drift apart silently.
    label: 'math block tier',
    block: {
      kind: 'math',
      id: 'contract-block#3',
      tex: '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}'
    }
  },
  {
    // A line carrying an inline formula: the line box grows past the type
    // line-height, so the run height is no longer lines × lineHeight.
    label: 'text run tier (inline math)',
    block: textRun(
      'contract-inline-math',
      'Energy $E = mc^2$ and a ratio $\\frac{\\frac{a}{b}}{\\frac{c}{d}}$ followed by enough text to wrap at the contract width.'
    )
  }
] satisfies Array<{
  label: string
  block: Block
}>

/**
 * A BlockFrame is given its height; the run laid out inside it is the box that can disagree. Rounded up as
 * `measure()` rounds — `offsetHeight` would round a fractional box (table borders, KaTeX struts) to nearest.
 */
const runHeight: ContractInspector = (host) => {
  const run = host.querySelector<HTMLElement>('.gg-md')
  return { runHeight: run ? Math.ceil(run.getBoundingClientRect().height) : -1 }
}

describe('block measure to rendered BlockFrame height contract', () => {
  it.each(blocks)('$label', async ({ label, block }) => {
    let reading: HeightContractReading
    switch (block.kind) {
      case 'html':
        reading = await renderAndMeasureBlock(htmlBlockDef, block, makeContractCtx({ width: WIDTH }), runHeight)
        expect(reading.inspected.runHeight, `${label}: no run rendered`).toBeGreaterThan(0)
        reading = { ...reading, dom: reading.inspected.runHeight }
        break
      case 'code':
        reading = await renderAndMeasureBlock(
          codeBlockDef,
          block,
          makeContractCtx({ width: WIDTH })
        )
        break
      case 'math':
        reading = await renderAndMeasureBlock(
          mathBlockDef,
          block,
          makeContractCtx({ width: WIDTH })
        )
        break
      default:
        throw new Error(`Unsupported contract block: ${block satisfies never}`)
    }
    measuredBlockTiers += 1
    renderedElements += reading.renderedElements
    expectHeightMatch(label, reading)
  })
})

afterAll(() => {
  // These are liveness controls for the measuring instrument. Zero means the
  // browser collector or renderer is broken, not that the geometry is clean.
  expect(measuredRows, 'height contract measured zero rows').toBeGreaterThan(0)
  expect(measuredBlockTiers, 'height contract measured zero block tiers').toBeGreaterThan(0)
  expect(renderedElements, 'height contract rendered zero DOM elements').toBeGreaterThan(0)
})
