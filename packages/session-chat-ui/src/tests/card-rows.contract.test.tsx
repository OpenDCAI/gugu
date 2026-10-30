/** @jsxImportSource solid-js */
import { textFilePatch } from '@gugu/session-core/lib';

/**
 * Height + inner-geometry contracts for the rows redrawn in the #3334 P3 third
 * batch (`file-op`, `execute`), plus the clipped-root scan those two sit inside.
 *
 * One file per batch, following `tool-rows.contract.test.tsx`: the shared
 * `height.contract.test.tsx` is a magnet every batch would otherwise edit.
 *
 * ── The blind spot this file closes ────────────────────────────────────────
 *
 * `measure() === offsetHeight` reads the row root's border-box height. But the
 * root is *given* that height, from the render side's own formula. So the
 * comparison is between two height formulas, never between a formula and the
 * content that actually laid out inside it. Whether the root also carries
 * `overflow: hidden` only decides how a drift shows up — clipped and invisible,
 * or spilled over the next row — and neither reaches `offsetHeight`.
 *
 * Scan of every row root that is handed an engine-computed explicit height,
 * taken on this commit:
 *
 *   row          root class        overflow          inner reading
 *   ───────────────────────────────────────────────────────────────────────
 *   tool         toolRow           hidden            here
 *   thinking     thinkingRoot      hidden            here
 *   plan         planRoot          hidden            here
 *   execute      collapsibleCard   hidden            here
 *   diff         diffRoot          (visible)         here
 *   file-op      fileOpRoot        (visible)         here
 *   subagent     subagentRoot      hidden            tool-rows.contract
 *   tool-group   toolGroupRoot     hidden            tool-rows.contract
 *
 * Two complementary reads, because neither alone is enough:
 *   - `scrollHeight` vs `clientHeight` catches content TALLER than the box the
 *     engine reserved (`scrollHeight >= clientHeight` always, so this one can
 *     never see slack).
 *   - the sum of the root's own children vs `clientHeight` catches content
 *     SHORTER than the reserved box, for the roots that are vertical stacks.
 *     Leaf rows centre inline content instead of stacking it, so they opt out
 *     via `stackedRoot: false` rather than asserting a number that is only
 *     coincidentally right.
 */

import { planUnitDef } from '@session-chat/components/rows/plan/plan.def'
import { thinkingUnitDef } from '@session-chat/components/rows/thinking/thinking.def'
import { diffUnitDef } from '@session-chat/components/rows/tools/diff/diff.def'
import { resourceLinkUnitDef } from '@session-chat/components/rows/resource-link/resource-link.def'
import { titleText, pathText } from '@session-chat/components/rows/resource-link/resource-link.css'
import { executeUnitDef } from '@session-chat/components/rows/tools/execute/execute.def'
import { fileOpUnitDef } from '@session-chat/components/rows/tools/file-op/file-op.def'
import { fileOpPathDir, fileOpPathName } from '@session-chat/components/rows/tools/file-op/file-op.css'
import { toolGroupUnitDef } from '@session-chat/components/rows/tools/tool-group/tool-group.def'
import { toolUnitDef } from '@session-chat/components/rows/tools/tool/tool.def'
import { DEFAULT_CONFIG, buildChatTheme } from '@session-chat/core/config'
import { DEFAULT_THEME } from '@session-chat/core/theme'
import type {
  ChatDiff,
  ChatExecute,
  ChatFileOpToolCall,
  ChatPlan,
  ChatThinking,
  ChatToolCall
} from '@session-chat/model'
import type { ItemNode } from '@session-chat/state/flatten'
import { afterAll, describe, expect, it } from 'vitest'
import {
  labelShortfall,
  makeContractCtx,
  measureSpill,
  renderAndMeasureUnit,
  type ContractCtx,
  type ContractInspector,
  type HeightContractReading
} from './contract'

const WIDTH = 420
/** Narrow enough that a missing ellipsis rule wraps instead of merely looking tight. */
const NARROW_WIDTH = 180

/**
 * A host whose measured body size is not the 14px that `0.875rem` resolves to,
 * so "drawn at the measured size" and "drawn at a rem step" stop agreeing.
 */
const bigBodyTheme = buildChatTheme({
  ...DEFAULT_CONFIG,
  roles: {
    ...DEFAULT_CONFIG.roles,
    body: { ...DEFAULT_CONFIG.roles.body, size: 18 }
  }
})

let measuredRows = 0
let renderedElements = 0

function expectHeightMatch(layer: string, reading: HeightContractReading): void {
  const delta = reading.dom - reading.computed
  expect(
    reading.dom,
    `${layer} height mismatch: engine=${reading.computed}px DOM=${reading.dom}px delta=${delta}px`
  ).toBe(reading.computed)
}

/**
 * Reads the row root from the inside. `childCount` is the liveness control: a
 * root with no children means the render never happened, and every number
 * below it would then be a reading of nothing.
 */
const inspectRoot: ContractInspector = (host) => {
  const root = host.firstElementChild as HTMLElement | null
  if (!root) return { childCount: 0, clientHeight: 0, contentExtent: 0, childSum: 0 }
  const children = Array.from(root.children) as HTMLElement[]
  return {
    childCount: children.length,
    clientHeight: root.clientHeight,
    contentExtent: root.scrollHeight,
    childSum: children.reduce((sum, child) => sum + child.offsetHeight, 0)
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const executeDone: ChatExecute = {
  kind: 'execute',
  id: 'card-execute-done',
  command: 'pnpm test:unit --filter session-chat-ui',
  inputSummary: 'Run task chat unit tests',
  outputText: 'contract collected\ncontract passed',
  status: 'done',
  startedAt: 0,
  durationMs: 500
}

const executeRunning: ChatExecute = {
  kind: 'execute',
  id: 'card-execute-running',
  command: 'pnpm build:renderer',
  inputSummary: 'Build the renderer bundle',
  status: 'running',
  startedAt: 0
}

const executeAwaiting: ChatExecute = {
  kind: 'execute',
  id: 'card-execute-awaiting',
  command: 'rm -rf dist',
  inputSummary: 'Clear the build output',
  status: 'running',
  awaitingPermission: true,
  startedAt: 0
}

const executeErrored: ChatExecute = {
  kind: 'execute',
  id: 'card-execute-error',
  command: 'pnpm typecheck',
  inputSummary: 'Typecheck the workspace',
  outputText: 'error TS2345: argument of type ...',
  status: 'error',
  error: 'exit code 2',
  startedAt: 0,
  durationMs: 900
}

/**
 * More output lines than `expandedMaxLines`, so the expanded reading exercises
 * the scroll clamp rather than re-testing the same short body twice.
 */
const executeLongOutput: ChatExecute = {
  kind: 'execute',
  id: 'card-execute-long',
  command: 'pnpm exec vitest run',
  inputSummary: 'Run the full unit suite',
  outputText: Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n'),
  status: 'done',
  startedAt: 0,
  durationMs: 4200
}

const fileOpSingle: ChatFileOpToolCall = {
  kind: 'file-op',
  id: 'card-file-op-single',
  op: 'read',
  status: 'done',
  ops: [{ path: 'packages/session-chat-ui/src/model.ts' }]
}

/** The command-bearing update has not arrived yet: the "Reading…" placeholder. */
const fileOpPending: ChatFileOpToolCall = {
  kind: 'file-op',
  id: 'card-file-op-pending',
  op: 'read',
  status: 'running',
  ops: []
}

const fileOpMulti: ChatFileOpToolCall = {
  kind: 'file-op',
  id: 'card-file-op-multi',
  op: 'edit',
  status: 'done',
  ops: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/c.ts' }]
}

/** Multi-file and still running: the PreviewWindow branch. */
const fileOpStreaming: ChatFileOpToolCall = {
  kind: 'file-op',
  id: 'card-file-op-streaming',
  op: 'edit',
  status: 'running',
  ops: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/c.ts' }, { path: 'src/d.ts' }]
}

/** One segment, so `basename` cannot shorten it: the row has to truncate. */
const longNameFileOp: ChatFileOpToolCall = {
  kind: 'file-op',
  id: 'card-file-op-long',
  op: 'edit',
  status: 'done',
  ops: [{ path: `src/${'extremely-long-file-name-segment-'.repeat(4)}component.tsx` }]
}

const longNameFileOpMulti: ChatFileOpToolCall = {
  kind: 'file-op',
  id: 'card-file-op-long-multi',
  op: 'edit',
  status: 'done',
  ops: [
    { path: `src/${'extremely-long-file-name-segment-'.repeat(4)}a.tsx` },
    { path: `src/${'extremely-long-file-name-segment-'.repeat(4)}b.tsx` }
  ]
}

const thinking: ChatThinking = {
  kind: 'thinking',
  id: 'card-thinking',
  status: 'done',
  text: 'First measured thought line.\n\nSecond measured thought line.',
  startedAt: 0,
  durationMs: 1_200
}

const plan: ChatPlan = {
  kind: 'plan',
  id: 'card-plan',
  entries: [
    { content: 'Measure the rendered row', status: 'completed', priority: 'high' },
    { content: 'Compare the exact heights', status: 'in_progress', priority: 'medium' }
  ]
}

const diff: ChatDiff = {
  kind: 'diff',
  id: 'card-diff',
  patches: [textFilePatch('src/height.ts', 'const height = 20;\nreturn height;', 'const height = 21;\nreturn height;\n// measured')],

  status: 'done'
}

const longNameDiff: ChatDiff = {
  ...diff,
  id: 'card-diff-long-name',
  patches: [textFilePatch(`src/${'extremely-long-diff-file-name-segment-'.repeat(4)}component.tsx`, 'before', 'after')]
}

const multiHunkDiff: ChatDiff = {
  ...diff,
  id: 'card-diff-multi-hunk',
  patches: [textFilePatch('src/multi-hunk.ts', Array.from({ length: 30 }, (_, index) => `const value${index} = ${index}`).join('\n'), Array.from({ length: 30 }, (_, index) =>
    [1, 15, 28].includes(index)
      ? `const value${index} = ${index + 100}`
      : `const value${index} = ${index}`
  ).join('\n'))],

}

const headerOnlyDiff: ChatDiff = {
  kind: 'diff',
  id: 'card-diff-header-only',
  patches: [{ changes: [{ operation: 'add', path: 'src/pending.ts' }], scope: 'unknown', patch: null }],

  status: 'running'
}

const tool: ChatToolCall = {
  kind: 'tool',
  id: 'card-tool',
  name: 'Read',
  status: 'done',
  inputSummary: 'packages/session-chat-ui/src/model.ts'
}

const expandedCtx = (id: string): ContractCtx =>
  makeContractCtx({ width: WIDTH, isCollapsed: (candidate) => candidate === id })

// ── Height contracts for the two redrawn rows ─────────────────────────────────

describe('file-op and execute measure to rendered border-box height contract', () => {
  it.each([
    {
      label: 'execute row (collapsed)',
      run: () => renderAndMeasureUnit(executeUnitDef, executeDone, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'execute row (expanded)',
      run: () => renderAndMeasureUnit(executeUnitDef, executeDone, expandedCtx(executeDone.id))
    },
    {
      label: 'execute row (running, no output yet)',
      run: () =>
        renderAndMeasureUnit(executeUnitDef, executeRunning, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'execute row (awaiting permission)',
      run: () =>
        renderAndMeasureUnit(executeUnitDef, executeAwaiting, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'execute row (error)',
      run: () =>
        renderAndMeasureUnit(executeUnitDef, executeErrored, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'execute row (expanded, output past the scroll clamp)',
      run: () =>
        renderAndMeasureUnit(executeUnitDef, executeLongOutput, expandedCtx(executeLongOutput.id))
    },
    {
      label: 'file-op row (single file)',
      run: () =>
        renderAndMeasureUnit(fileOpUnitDef, fileOpSingle, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'file-op row (running, no path yet)',
      run: () =>
        renderAndMeasureUnit(fileOpUnitDef, fileOpPending, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'file-op row (multi-file, collapsed)',
      run: () => renderAndMeasureUnit(fileOpUnitDef, fileOpMulti, makeContractCtx({ width: WIDTH }))
    },
    {
      label: 'file-op row (multi-file, expanded)',
      run: () => renderAndMeasureUnit(fileOpUnitDef, fileOpMulti, expandedCtx(fileOpMulti.id))
    },
    {
      label: 'file-op row (multi-file, streaming preview)',
      run: () =>
        renderAndMeasureUnit(fileOpUnitDef, fileOpStreaming, makeContractCtx({ width: WIDTH }))
    }
  ])('$label', async ({ label, run }) => {
    const reading = await run()
    measuredRows += 1
    renderedElements += reading.renderedElements
    expectHeightMatch(label, reading)
  })
})

// ── Clipped-root scan: what offsetHeight structurally cannot see ──────────────

type ClippedRootCase = {
  label: string
  /**
   * False for roots that centre inline content instead of stacking blocks, so
   * the child sum is legitimately smaller than the row. Those still get the
   * overflow read.
   */
  stackedRoot: boolean
  run: () => Promise<HeightContractReading>
}

const clippedRootCases: ClippedRootCase[] = [
  {
    label: 'tool row',
    stackedRoot: false,
    run: () =>
      renderAndMeasureUnit(toolUnitDef, tool, makeContractCtx({ width: WIDTH }), inspectRoot)
  },
  {
    label: 'thinking row (collapsed)',
    stackedRoot: true,
    run: () =>
      renderAndMeasureUnit(
        thinkingUnitDef,
        thinking,
        makeContractCtx({ width: WIDTH }),
        inspectRoot
      )
  },
  {
    label: 'thinking row (expanded)',
    stackedRoot: true,
    run: () =>
      renderAndMeasureUnit(thinkingUnitDef, thinking, expandedCtx(thinking.id), inspectRoot)
  },
  {
    label: 'plan row (collapsed)',
    stackedRoot: true,
    run: () =>
      renderAndMeasureUnit(planUnitDef, plan, makeContractCtx({ width: WIDTH }), inspectRoot)
  },
  {
    label: 'plan row (expanded)',
    stackedRoot: true,
    run: () => renderAndMeasureUnit(planUnitDef, plan, expandedCtx(plan.id), inspectRoot)
  },
  {
    label: 'diff row',
    stackedRoot: true,
    run: () =>
      renderAndMeasureUnit(diffUnitDef, diff, makeContractCtx({ width: WIDTH }), inspectRoot)
  },
  {
    label: 'execute row (collapsed)',
    // This entry was `stackedRoot: false` while the card shell was still here:
    // the shell reserved 3 border widths, but `box-sizing: border-box`
    // (styles/reset) puts the header separator inside the header's own 32px, so
    // one of the three was never spent and the card carried 1px of slack —
    // clientHeight 73 against a 72px child sum. Dropping the shell settles it.
    stackedRoot: true,
    run: () =>
      renderAndMeasureUnit(
        executeUnitDef,
        executeDone,
        makeContractCtx({ width: WIDTH }),
        inspectRoot
      )
  },
  {
    label: 'execute row (expanded)',
    stackedRoot: true,
    run: () =>
      renderAndMeasureUnit(executeUnitDef, executeDone, expandedCtx(executeDone.id), inspectRoot)
  },
  {
    label: 'file-op row (single file)',
    stackedRoot: true,
    run: () =>
      renderAndMeasureUnit(
        fileOpUnitDef,
        fileOpSingle,
        makeContractCtx({ width: WIDTH }),
        inspectRoot
      )
  },
  {
    label: 'file-op row (multi-file, collapsed)',
    stackedRoot: true,
    run: () =>
      renderAndMeasureUnit(
        fileOpUnitDef,
        fileOpMulti,
        makeContractCtx({ width: WIDTH }),
        inspectRoot
      )
  },
  {
    label: 'file-op row (multi-file, expanded)',
    stackedRoot: true,
    run: () =>
      renderAndMeasureUnit(fileOpUnitDef, fileOpMulti, expandedCtx(fileOpMulti.id), inspectRoot)
  },
  {
    label: 'file-op row (multi-file, streaming preview)',
    stackedRoot: true,
    run: () =>
      renderAndMeasureUnit(
        fileOpUnitDef,
        fileOpStreaming,
        makeContractCtx({ width: WIDTH }),
        inspectRoot
      )
  }
]

describe('row roots hold exactly the content the engine reserved for them', () => {
  it.each(clippedRootCases)('$label', async ({ label, stackedRoot, run }) => {
    const reading = await run()
    measuredRows += 1
    renderedElements += reading.renderedElements
    expectHeightMatch(label, reading)

    const { childCount, clientHeight, contentExtent, childSum } = reading.inspected
    expect(childCount, `${label}: inspector found an empty root, so it measured nothing`).toBeGreaterThan(0)
    expect(
      contentExtent,
      `${label}: content laid out ${contentExtent}px inside a ${clientHeight}px row — the excess is clipped or spills over the next row, and offsetHeight reads clean either way`
    ).toBe(clientHeight)
    if (stackedRoot) {
      expect(
        childSum,
        `${label}: the root's own children stack to ${childSum}px inside a ${clientHeight}px row, leaving ${clientHeight - childSum}px the engine reserved and nothing occupies`
      ).toBe(clientHeight)
    }
  })
})

// ── Diff root containment ────────────────────────────────────────────────────

describe('diff root contains the geometry the engine gives it', () => {
  it('measureSpill reports a deliberately over-wide control', () => {
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:20px'
    const wideChild = document.createElement('div')
    wideChild.style.cssText = 'width:140px;height:20px'
    host.appendChild(wideChild)
    document.body.appendChild(host)

    try {
      expect(measureSpill(host), 'measureSpill positive control returned zero').toBeGreaterThanOrEqual(39.5)
    } finally {
      host.remove()
    }
  })

  it.each([
    {
      label: 'collapse flag off',
      item: diff,
      ctx: makeContractCtx({ width: WIDTH })
    },
    {
      label: 'collapse flag on (diff has no collapsed branch)',
      item: diff,
      ctx: makeContractCtx({
        width: WIDTH,
        isCollapsed: (candidate) => candidate === diff.id
      })
    },
    {
      label: 'long file name at 180px',
      item: longNameDiff,
      ctx: makeContractCtx({ width: NARROW_WIDTH })
    },
    {
      label: 'multiple hunks past the preview limit',
      item: multiHunkDiff,
      ctx: makeContractCtx({ width: WIDTH })
    },
    {
      label: 'multiple hunks at 180px',
      item: multiHunkDiff,
      ctx: makeContractCtx({ width: NARROW_WIDTH })
    },
    {
      label: 'running before diff content arrives',
      item: headerOnlyDiff,
      ctx: makeContractCtx({ width: NARROW_WIDTH })
    }
  ])('$label', async ({ label, item, ctx }) => {
    const reading = await renderAndMeasureUnit(diffUnitDef, item, ctx, inspectRoot)
    measuredRows += 1
    renderedElements += reading.renderedElements
    expectHeightMatch(`diff ${label}`, reading)
    expect(
      reading.spill,
      `diff ${label}: spilled ${reading.spill}px horizontally past its fixed-width host`
    ).toBeLessThanOrEqual(0.5)
  })

  it('diff root contains a transient body taller than its reserved height', async () => {
    const reading = await renderAndMeasureUnit(
      diffUnitDef,
      multiHunkDiff,
      makeContractCtx({ width: NARROW_WIDTH }),
      (host) => {
        const root = host.firstElementChild as HTMLElement | null
        const body = root?.children.item(1) as HTMLElement | null
        if (!root || !body) {
          return {
            rootFound: root ? 1 : 0,
            bodyFound: body ? 1 : 0,
            clientHeight: 0,
            contentExtent: 0,
            overflowHidden: 0,
            bodyPaintedOutside: 0
          }
        }

        // Mid-frame data/geometry skew: the body has arrived, while the reserved
        // root height still reflects the preceding header-only render.
        root.style.height = '32px'
        const rootRect = root.getBoundingClientRect()
        const bodyRect = body.getBoundingClientRect()
        const sampleX = bodyRect.left + Math.min(8, bodyRect.width / 2)
        const sampleY = bodyRect.top + Math.min(8, bodyRect.height / 2)
        const hit = document.elementFromPoint(sampleX, sampleY)

        return {
          rootFound: 1,
          bodyFound: 1,
          clientHeight: root.clientHeight,
          contentExtent: root.scrollHeight,
          overflowHidden: getComputedStyle(root).overflow === 'hidden' ? 1 : 0,
          bodyPaintedOutside:
            sampleY > rootRect.bottom && hit instanceof Element && body.contains(hit) ? 1 : 0
        }
      }
    )
    measuredRows += 1
    renderedElements += reading.renderedElements
    expectHeightMatch('diff transient height skew (before probe)', reading)

    const {
      rootFound,
      bodyFound,
      clientHeight,
      contentExtent,
      overflowHidden,
      bodyPaintedOutside
    } = reading.inspected
    expect(rootFound, 'transient containment inspector found no diff root').toBe(1)
    expect(bodyFound, 'transient containment inspector found no diff body').toBe(1)
    expect(
      contentExtent,
      `transient control did not overflow: scrollHeight=${contentExtent}px clientHeight=${clientHeight}px`
    ).toBeGreaterThan(clientHeight)
    expect(overflowHidden, 'diff root does not clip a transient height surplus').toBe(1)
    expect(bodyPaintedOutside, 'diff body remained paint-hit-testable below its reserved root').toBe(0)
  })
})

// ── A long file name stays on its line ────────────────────────────────────────

describe('file-op keeps an over-long file name inside the row it was measured at', () => {
  // Before the redraw this row had no ellipsis rule, so the name wrapped: at
  // 180px it laid out 93px of content inside the 32px the engine reserved, and
  // 46px inside 108px when expanded. `fileOpRoot` carried no `overflow: hidden`,
  // so the extra lines drew over the following rows — and `measure() ===
  // offsetHeight` read 32 === 32 the whole time, because the root is handed its
  // height rather than growing to its content.
  it.each([
    {
      label: 'single file',
      run: () =>
        renderAndMeasureUnit(
          fileOpUnitDef,
          longNameFileOp,
          makeContractCtx({ width: NARROW_WIDTH }),
          inspectRoot
        )
    },
    {
      label: 'expanded list',
      run: () =>
        renderAndMeasureUnit(
          fileOpUnitDef,
          longNameFileOpMulti,
          makeContractCtx({
            width: NARROW_WIDTH,
            isCollapsed: (candidate) => candidate === longNameFileOpMulti.id
          }),
          inspectRoot
        )
    }
  ])('$label', async ({ label, run }) => {
    const reading = await run()
    measuredRows += 1
    renderedElements += reading.renderedElements
    expectHeightMatch(`file-op long name (${label})`, reading)

    const { childCount, clientHeight, contentExtent } = reading.inspected
    expect(childCount, `file-op long name (${label}): inspector measured an empty root`).toBeGreaterThan(0)
    expect(
      contentExtent,
      `file-op long name (${label}): the name wrapped to ${contentExtent}px inside a ${clientHeight}px row`
    ).toBe(clientHeight)
    expect(
      reading.spill,
      `file-op long name (${label}): spilled ${reading.spill}px past the ${NARROW_WIDTH}px row width`
    ).toBeLessThanOrEqual(0.5)
  })
})

// ── The directory gives way before the verb and the file name ─────────────────

describe('file-op header: the directory gives way before the verb and the file name', () => {
  // 2026-10-16 desktop: 「读… …/task-attachments/a9c5e87a-8cb0-4943…b2933f13-…-image.p…」 —
  // a shrink weight on the directory (100 against 1) only made the verb's and the
  // name's shares small, and any share at all paints an ellipsis. Both read whole
  // while the directory still has room to give.
  const deepPath: ChatFileOpToolCall = {
    kind: 'file-op',
    id: 'card-file-op-deep-path',
    op: 'read',
    status: 'done',
    ops: [
      {
        path: '/root/.gugu-server/accounts/fcdf6314-bd57-4677-a766-1da4faf3e4fa/data/task-attachments/a9c5e87a-8cb0-4943-9b96-3a57dcfc074f/b2933f13-image.png'
      }
    ]
  }

  // With a payload the row is a disclosure (verb in the shared header label, the
  // path in its trailing slot — the screenshot's row); without one it is a plain row.
  it.each([
    { label: 'disclosure header', item: { ...deepPath, request: '{"file_path":"…"}', result: 'line\n' } },
    { label: 'plain row', item: deepPath }
  ])('keeps the verb and the file name whole ($label)', async ({ item }) => {
    const reading = await renderAndMeasureUnit(fileOpUnitDef, item, makeContractCtx({ width: WIDTH }), (host) => {
      // Both classes are compositions ("a b"), so select on every name, not as a descendant chain.
      const sel = (cls: string) => cls.split(' ').map((c) => `.${c}`).join('')
      const dir = host.querySelector<HTMLElement>(sel(fileOpPathDir))
      const name = host.querySelector<HTMLElement>(sel(fileOpPathName))
      // The verb is the first cell of whichever line holds the path.
      const line = name?.closest<HTMLElement>('[data-slot="collapse-header"]') ?? name?.parentElement?.parentElement
      const verb = line?.firstElementChild as HTMLElement | null | undefined
      return {
        found: verb && dir && name ? 1 : 0,
        verbShort: verb ? labelShortfall(verb) : -1,
        nameShort: name ? labelShortfall(name) : -1,
        dirClipped: dir ? dir.scrollWidth - dir.clientWidth : -1
      }
    })
    const { found, verbShort, nameShort, dirClipped } = reading.inspected
    expect(found, 'probe found no verb / directory / name under the header').toBe(1)
    // Positive control: the directory really is too long, otherwise nothing competes.
    expect(dirClipped, 'the directory fit, so this row proves nothing').toBeGreaterThan(0)
    expect(verbShort, `verb ${verbShort}px short of its own width`).toBeLessThanOrEqual(0.01)
    expect(nameShort, `file name ${nameShort}px short of its own width`).toBeLessThanOrEqual(0.01)
  })
})

// ── The reader's token stays whole while a secondary cell can still give (#7316) ──

describe('rows keep the reader\'s token whole while a secondary cell can still give', () => {
  // Same disease as the file-op verb: two cells shrinking in proportion clip the one the reader came for
  // while the other still has room. Found by sweeping every label-beside-detail line after 「执…」.
  const sel = (cls: string) => cls.split(' ').map((c) => `.${c}`).join('')

  it('resource link: the name keeps every pixel while the path still has room', async () => {
    const deep = `${'deeply-nested-directory/'.repeat(8)}component-ownership-map.tsx`
    const reading = await renderAndMeasureUnit(
      resourceLinkUnitDef,
      { kind: 'resource-link', id: 'card-resource-link-deep', uri: `file:///repo/${deep}`, name: 'component-ownership-map.tsx', target: { kind: 'workspace-file', path: deep } } as never,
      makeContractCtx({ width: WIDTH }),
      (host) => {
        const title = host.querySelector<HTMLElement>(sel(titleText))
        const path = host.querySelector<HTMLElement>(sel(pathText))
        return {
          found: title && path ? 1 : 0,
          titleShort: title ? labelShortfall(title) : -1,
          pathClipped: path ? path.scrollWidth - path.clientWidth : -1,
        }
      }
    )
    const { found, titleShort, pathClipped } = reading.inspected
    expect(found, 'probe found no title / path cell').toBe(1)
    expect(pathClipped, 'the path fit, so nothing competed').toBeGreaterThan(0)
    expect(titleShort, `name ${titleShort}px short of its own width`).toBeLessThanOrEqual(0.01)
  })

  it('diff header: a failure reason that fits the free space is not cut at half the row', async () => {
    // Longer than half the free space, shorter than all of it: a spacer splitting the free space with the
    // reason cuts it next to an equally wide empty gap.
    const failed: ChatDiff = { ...diff, id: 'card-diff-failed', status: 'error', error: 'patch did not apply: hunk #2 failed at line 41' }
    const reading = await renderAndMeasureUnit(diffUnitDef, failed, makeContractCtx({ width: 640 }), (host) => {
      const reason = host.querySelector<HTMLElement>('[data-slot="tool-call-error"]')
      return { found: reason ? 1 : 0, reasonShort: reason ? labelShortfall(reason) : -1 }
    })
    expect(reading.inspected.found, 'no failure reason on the header').toBe(1)
    expect(reading.inspected.reasonShort, `reason ${reading.inspected.reasonShort}px short with room to spare`).toBeLessThanOrEqual(0.01)
  })
})

// ── The row is drawn at the size it was measured at ───────────────────────────

describe('file-op renders at the body size the engine measured with', () => {
  // The spec body requires measurement and display to consume the same
  // ChatConfig type role. `fileRow` used the `sm` sprinkle (0.875rem), which
  // lands on 14px only while the host root font-size is 16px — the same size
  // DEFAULT_CONFIG happens to give `body`. Two independent numbers that agreed
  // by coincidence, so nothing went wrong and nothing could report it.
  //
  // The control is a theme whose body size is NOT 14: under the old rule the row
  // stayed at 14px while the engine measured with 18px.
  it.each([
    { label: 'default body size', theme: DEFAULT_THEME, expected: DEFAULT_CONFIG.roles.body.size },
    { label: 'host body size 18px', theme: bigBodyTheme, expected: 18 }
  ])('$label', async ({ label, theme, expected }) => {
    const reading = await renderAndMeasureUnit(
      fileOpUnitDef,
      fileOpSingle,
      makeContractCtx({ width: WIDTH, theme }),
      (host) => {
        const row = host.querySelector<HTMLElement>(`[role="button"]`)
        return {
          rowFound: row ? 1 : 0,
          fontSizePx: row ? parseFloat(getComputedStyle(row).fontSize) : 0
        }
      }
    )
    measuredRows += 1
    renderedElements += reading.renderedElements

    const { rowFound, fontSizePx } = reading.inspected
    expect(rowFound, `file-op type scale (${label}): inspector found no file row`).toBe(1)
    expect(
      fontSizePx,
      `file-op type scale (${label}): drawn at ${fontSizePx}px while the engine measured with ${expected}px`
    ).toBe(expected)
  })
})

// ── The rows say WHICH file, not just that there was one ──────────────────────

/**
 * Every geometry contract above is satisfied by a correctly-sized empty box, and
 * every one of them was satisfied while a batch of thirty file reads rendered as
 * thirty rows all reading `index.ts`. Height is orthogonal to legibility, so
 * legibility needs a reading of its own — and it has to read *structure*: text a
 * flat list of bare file names cannot produce.
 *
 * The composition under test is the one ACP actually builds. `wrapReadGroups`
 * folds a consecutive run of `read-tool-call`s into a `tool-group`, and each
 * child becomes a file-op row carrying exactly one path — `readFileOpFromItem`
 * and `deleteFileOpFromItem` are the only ACP-reachable producers and neither
 * can emit more than one. So the batch is a group of single-path rows, never one
 * row holding a list.
 */
const SAME_NAME_BATCH = [
  'packages/session-chat-ui/src/components/rows/tools/file-op/index.ts',
  'packages/session-chat-ui/src/components/rows/tools/diff/index.ts',
  'packages/session-chat-ui/src/components/rows/markdown/code/index.ts',
  'packages/session-core/src/acp/reducer/index.ts'
]

const readBatch: ItemNode = {
  item: {
    kind: 'tool',
    id: 'card-read-batch',
    name: `${SAME_NAME_BATCH.length} file reads`,
    status: 'done'
  } as ChatToolCall,
  children: SAME_NAME_BATCH.map((path, index) => ({
    item: {
      kind: 'file-op',
      id: `card-read-batch-${index}`,
      op: 'read',
      status: 'done',
      ops: [{ path }]
    } as ChatFileOpToolCall,
    children: []
  }))
}

describe('a batch of same-named files renders as rows that can be told apart', () => {
  it('each row names its own file', async () => {
    const reading = await renderAndMeasureUnit(
      toolGroupUnitDef,
      readBatch,
      expandedCtx(readBatch.item.id),
      (host) => {
        // The group's own collapse header is a `[role="button"]` too, so file
        // rows are identified by the path cell they carry, not by the role
        // alone — the cell holds the full path as its title, which is also how
        // we check that nothing was invented.
        const rows = Array.from(host.querySelectorAll<HTMLElement>('[role="button"]')).filter(
          (row) => row.querySelector('[title]')
        )
        const texts = rows.map((row) => {
          const cell = row.querySelector<HTMLElement>('[title]')
          return {
            shown: (cell?.textContent ?? '').replace(/\s+/g, ''),
            full: cell?.getAttribute('title') ?? ''
          }
        })
        const shown = texts.map((entry) => entry.shown)
        return {
          rowsRendered: rows.length,
          distinctRowTexts: new Set(shown).size,
          // A row that shows only the leaf is the defect this closes: four such
          // rows are four identical lines.
          leafOnlyRows: texts.filter(
            (entry) => entry.shown === entry.full.split('/').pop() && entry.full.includes('/')
          ).length,
          // Nothing is invented: what is drawn (minus the elision marker) has to
          // be a real tail of the real path.
          suffixOfRealPath: texts.filter((entry) =>
            entry.full.replace(/\s+/g, '').endsWith(entry.shown.replace(/^…\//, ''))
          ).length,
          emptyRows: shown.filter((text) => text.length === 0).length
        }
      }
    )
    measuredRows += 1
    renderedElements += reading.renderedElements

    const { rowsRendered, distinctRowTexts, leafOnlyRows, suffixOfRealPath, emptyRows } =
      reading.inspected

    // Liveness first: zero rows would make every assertion below vacuously true.
    expect(rowsRendered, 'read-batch inspector found no file rows to read').toBe(
      SAME_NAME_BATCH.length
    )
    expect(emptyRows, 'read-batch rendered rows with no path text at all').toBe(0)
    // Ordered so a regression reads cleanly: "nothing was invented" holds for a
    // bare file name too, so it stays green under the old behaviour and only the
    // two legibility readings below turn over. A criterion that flipped all
    // three at once would be detecting *change*, not this defect.
    expect(
      suffixOfRealPath,
      'a row drew path text that is not a tail of the path it links to'
    ).toBe(SAME_NAME_BATCH.length)
    expect(
      leafOnlyRows,
      `${leafOnlyRows} of ${rowsRendered} rows showed only the file name, so they read identically`
    ).toBe(0)
    expect(
      distinctRowTexts,
      `${rowsRendered} files in ${rowsRendered} different directories rendered as ${distinctRowTexts} distinct line(s)`
    ).toBe(SAME_NAME_BATCH.length)
  })
})

afterAll(() => {
  // Liveness controls for the measuring instrument. Zero means the browser
  // collector or the renderer is broken, not that the geometry is clean.
  expect(measuredRows, 'card-row contract measured zero rows').toBeGreaterThan(0)
  expect(renderedElements, 'card-row contract rendered zero DOM elements').toBeGreaterThan(0)
})
