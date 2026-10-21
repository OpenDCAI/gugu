/** @jsxImportSource solid-js */
/**
 * Contracts for the rows redrawn in the #3334 P3 fourth batch: `thinking`,
 * `message` (assistant / thought) and `user-message`.
 *
 * One file per batch, following `card-rows.contract.test.tsx` — the shared
 * `height.contract.test.tsx` is a magnet every batch would otherwise edit.
 *
 * ── What this batch pins, and why it is not "remove the card" ──────────────
 *
 * The first three batches took cards off AGENT-side rows so agent output reads
 * as one continuous column. `user-message` is not that: after those batches it
 * is the ONLY container left in the transcript that draws a border, a filled
 * background and a radius, and there is no avatar, no speaker label and no
 * alignment shift anywhere in the row set. So the card is the whole speaker
 * boundary — stripping it would not "finish" the redraw, it would delete the
 * only cue that separates what the user said from what the agent said.
 *
 * Hence the inventory below is two-sided, and both sides can fail:
 *   - `thinking` and `message` must carry NO decoration (a future card added
 *     back to them goes red),
 *   - `user-message` must KEEP exactly one bordered, token-filled surface
 *     (stripping the bubble also goes red).
 * A one-sided version would be an instrument that only ever says "less".
 *
 * ── The measurement hazard this file had to work around ────────────────────
 *
 * A computed-style read of a bare transcript is NOT a read of the product. The
 * package's own `reset.css.ts` deliberately carries only the rules that affect
 * measured height, so before this batch a `<button>` with no local reset kept
 * the UA chrome — `2px outset` + `buttonface`. In the product that never shows,
 * because the task renderer imports Tailwind, whose preflight sets `border: 0
 * solid` on `*` and `background-color: transparent` on `button` document-wide
 * (one `<head>` for both stylesheets since #2804). So the first reading of
 * `message` here showed a 4-edge border that the product does not have.
 *
 * That is fixed at the source rather than filtered out here: the package now
 * resets button chrome itself, so this harness and the product agree instead of
 * this file carrying a "ignore buttons" clause that would also hide a real one.
 */

import { pblock } from '@session-chat/components/engine/block-frame.css'
import { messageUnitDef } from '@session-chat/components/rows/message/message.def'
import { thinkingUnitDef } from '@session-chat/components/rows/thinking/thinking.def'
import type { ChatMessage, ChatThinking } from '@session-chat/model'
import { describe, expect, it } from 'vitest'
import {
  makeContractCtx,
  labelShortfall,
  renderAndMeasureUnit,
  type ContractCtx,
  type ContractInspector,
  type HeightContractReading
} from './contract'

const WIDTH = 420
/** Narrow enough that the body wraps to many lines instead of merely looking tight. */
const NARROW_WIDTH = 180

function expectHeightMatch(layer: string, reading: HeightContractReading): void {
  const delta = reading.dom - reading.computed
  expect(
    reading.dom,
    `${layer} height mismatch: engine=${reading.computed}px DOM=${reading.dom}px delta=${delta}px`
  ).toBe(reading.computed)
}

// ── Decoration inventory ──────────────────────────────────────────────────────

/**
 * Same ruler as the real-Electron evidence spec (`task-chat-before-3334.spec.ts`,
 * the #3345 baseline), so the numbers here and there are comparable readings of
 * one fact rather than two scales that happen to share a word.
 *
 * `elementCount` is the liveness control: an empty subtree would score zero on
 * every decoration below, and "nothing rendered" must not read as "nothing
 * decorated".
 *
 * Box-shadows are split. A `0 0 0 <n>px` shadow has no blur and no offset — it
 * is a hairline ring standing in for a border (the technique ui-visual-spec §6.1
 * prefers, because a ring does not occupy layout). Counting it as a projection
 * would report the §6 shadow limit as breached by something that casts nothing.
 *
 * The subject is the ROW'S OWN chrome, so anything inside a markdown `BlockFrame`
 * is excluded and counted separately as `blockLayerDecorations`. An inline-code
 * chip has a filled background because that is how inline code reads; it is
 * content owned by the markdown block defs, not a card this row drew around
 * itself. Without the split, "message draws no container" would fail on a
 * backtick. `blockLayerDecorations` is asserted non-zero where the fixture has
 * one, so the exclusion is never silently excluding an empty set.
 */
const inventory =
  (theme: 'light' | 'dark'): ContractInspector =>
  (host) => {
    if (theme === 'dark') host.classList.add('emdark')

    const px = (value: string): number => Number.parseFloat(value) || 0
    const transparent = (color: string): boolean => {
      const normalized = color.replaceAll(' ', '').toLowerCase()
      if (normalized === 'transparent') return true
      const rgba = /^rgba\([^,]+,[^,]+,[^,]+,([^)]+)\)$/.exec(normalized)
      return rgba ? Number(rgba[1]) === 0 : false
    }
    const borderEdges = (style: CSSStyleDeclaration): number =>
      [
        [style.borderTopWidth, style.borderTopStyle],
        [style.borderRightWidth, style.borderRightStyle],
        [style.borderBottomWidth, style.borderBottomStyle],
        [style.borderLeftWidth, style.borderLeftStyle]
      ].filter(([width, kind]) => px(width) > 0 && kind !== 'none' && kind !== 'hidden').length

    const elements = [host, ...Array.from(host.querySelectorAll<HTMLElement>('*'))].filter(
      (element) => {
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }
    )

    let borderedElements = 0
    let borderEdgeCount = 0
    let filledSurfaces = 0
    let roundedElements = 0
    let projectionShadows = 0
    let hairlineRings = 0
    let maxRadius = 0
    let blockLayerDecorations = 0

    for (const element of elements) {
      const style = getComputedStyle(element)

      if (element.closest(`.${pblock}`)) {
        const decorated =
          borderEdges(style) > 0 ||
          !transparent(style.backgroundColor) ||
          style.boxShadow !== 'none'
        if (decorated) blockLayerDecorations += 1
        continue
      }

      const edges = borderEdges(style)
      borderEdgeCount += edges
      if (edges > 0) borderedElements += 1

      // A gradient-only layer (the overflow fade) paints no surface colour.
      if (!transparent(style.backgroundColor)) filledSurfaces += 1

      const radii = [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius
      ].map(px)
      if (radii.some((radius) => radius > 0)) {
        roundedElements += 1
        maxRadius = Math.max(maxRadius, ...radii)
      }

      if (style.boxShadow !== 'none') {
        // "<color> Xpx Ypx Bpx Spx" — offsets and blur all zero means a ring.
        const lengths = style.boxShadow.match(/-?[\d.]+px/g) ?? []
        const [offsetX = 0, offsetY = 0, blur = 0] = lengths.slice(0, 3).map(px)
        if (offsetX === 0 && offsetY === 0 && blur === 0) hairlineRings += 1
        else projectionShadows += 1
      }
    }

    return {
      elementCount: elements.length,
      borderedElements,
      borderEdgeCount,
      filledSurfaces,
      roundedElements,
      projectionShadows,
      hairlineRings,
      maxRadius,
      blockLayerDecorations
    }
  }

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BODY =
  'A measured body with enough words that it wraps over several lines at the contract width.'

const thinkingDone: ChatThinking = {
  kind: 'thinking',
  id: 'msg-thinking-done',
  status: 'done',
  startedAt: 0,
  durationMs: 3000,
  text: `${BODY}\n\nAnd a second paragraph so the expanded body is a real stack.`
}

const assistantMessage: ChatMessage = {
  kind: 'message',
  id: 'msg-assistant',
  role: 'assistant',
  text: `${BODY} It also carries **bold** and \`inline code\`.`
}

const thoughtMessage: ChatMessage = {
  kind: 'message',
  id: 'msg-thought',
  role: 'thought',
  text: BODY
}

const userMessage: ChatMessage = {
  kind: 'message',
  id: 'msg-user',
  role: 'user',
  text: 'Fix the header alignment on the settings page.'
}

const userMessageOverflowing: ChatMessage = {
  kind: 'message',
  id: 'msg-user-overflow',
  role: 'user',
  text: Array.from({ length: 14 }, (_, index) => `Line ${index} of a long request.`).join('\n\n')
}

const expandedCtx = (id: string, width = WIDTH): ContractCtx =>
  makeContractCtx({ width, isCollapsed: (candidate) => candidate === id })

// ── 1. Decoration inventory ───────────────────────────────────────────────────

describe('fourth-batch decoration inventory', () => {
  for (const theme of ['light', 'dark'] as const) {
    describe(theme, () => {
      const undecorated: Array<{ label: string; run: () => Promise<HeightContractReading> }> = [
        {
          label: 'thinking collapsed',
          run: () =>
            renderAndMeasureUnit(
              thinkingUnitDef,
              thinkingDone,
              makeContractCtx({ width: WIDTH }),
              inventory(theme)
            )
        },
        {
          label: 'thinking expanded',
          run: () =>
            renderAndMeasureUnit(
              thinkingUnitDef,
              thinkingDone,
              expandedCtx(thinkingDone.id),
              inventory(theme)
            )
        },
        {
          label: 'assistant message',
          run: () =>
            renderAndMeasureUnit(
              messageUnitDef,
              assistantMessage,
              makeContractCtx({ width: WIDTH }),
              inventory(theme)
            )
        },
        {
          label: 'thought message',
          run: () =>
            renderAndMeasureUnit(
              messageUnitDef,
              thoughtMessage,
              makeContractCtx({ width: WIDTH }),
              inventory(theme)
            )
        }
      ]

      for (const { label, run } of undecorated) {
        it(`${label} draws no container of its own`, async () => {
          const reading = await run()
          expectHeightMatch(`${label} [${theme}]`, reading)

          const {
            elementCount,
            borderedElements,
            borderEdgeCount,
            filledSurfaces,
            roundedElements,
            projectionShadows
          } = reading.inspected

          expect(elementCount, `${label}: nothing rendered, inventory reads nothing`).toBeGreaterThan(
            1
          )
          expect(borderedElements, `${label}: drew ${borderEdgeCount} border edges`).toBe(0)
          expect(filledSurfaces, `${label}: painted ${filledSurfaces} filled surfaces`).toBe(0)
          expect(roundedElements, `${label}: rounded ${roundedElements} corners`).toBe(0)
          expect(projectionShadows, `${label}: cast ${projectionShadows} shadows`).toBe(0)
        })
      }

      it('the block-layer exclusion is excluding something, not an empty set', async () => {
        // The assistant fixture carries an inline-code chip, which is filled. If
        // this ever reads 0 the four "draws no container" zeros above stopped
        // being evidence: they would pass just as well on a row that renders
        // nothing at all through the markdown layer.
        const reading = await renderAndMeasureUnit(
          messageUnitDef,
          assistantMessage,
          makeContractCtx({ width: WIDTH }),
          inventory(theme)
        )
        expect(
          reading.inspected.blockLayerDecorations,
          'no decorated element inside a BlockFrame — the exclusion is untested'
        ).toBeGreaterThan(0)
      })

      it('user message keeps exactly one bordered, filled speaker surface', async () => {
        const reading = await renderAndMeasureUnit(
          messageUnitDef,
          userMessage,
          makeContractCtx({ width: WIDTH }),
          inventory(theme)
        )
        expectHeightMatch(`user message [${theme}]`, reading)

        const {
          elementCount,
          borderedElements,
          borderEdgeCount,
          filledSurfaces,
          maxRadius,
          projectionShadows
        } = reading.inspected

        expect(elementCount, 'user message: nothing rendered').toBeGreaterThan(1)
        // The speaker boundary. Both directions matter: 0 means the bubble was
        // stripped and the user's words now read as the agent's, >1 means a
        // second container crept in underneath it.
        expect(borderedElements, 'user message lost or duplicated its speaker card').toBe(1)
        expect(borderEdgeCount, 'the speaker card is not a closed box').toBe(4)
        expect(filledSurfaces, 'the speaker card lost its fill').toBe(1)
        // ui-visual-spec §6: shadows may not exceed shadow-sm. The card expresses
        // its layer with a background, exactly as §6 asks, and casts nothing.
        expect(projectionShadows, 'the speaker card started casting a shadow').toBe(0)
        // 2026-09-22(Refs #6109):钉子从 8 挪到 **16**。
        // 理由不是「这一处想圆一点」,而是 design.md 的 shape 表给了这一档自己的名字与语义:
        // `--radius-thread` = 16px =「composer **and user bubble**, product surfaces only」。
        // 原来这里钉的是 radiusMd(8px,2026-09-03 从 radiusLg 收敛过来的),而同一个部件
        // 在本仓曾有 8 / 12 / 14 三个取值,没有一个落在 16 上 —— 钉子本身是对的,
        // 钉错了位置。钉子照旧:单独改这一处仍会造出第四种刻度。
        expect(maxRadius, 'the speaker card radius left the package surface scale').toBe(16)
      })

      it('user message keeps its fill and border while overflowing', async () => {
        const reading = await renderAndMeasureUnit(
          messageUnitDef,
          userMessageOverflowing,
          makeContractCtx({ width: WIDTH }),
          inventory(theme)
        )
        expectHeightMatch(`user message overflowing [${theme}]`, reading)

        const { borderedElements, filledSurfaces, projectionShadows } = reading.inspected
        expect(borderedElements, 'overflowing user card lost its border').toBe(1)
        expect(filledSurfaces, 'overflowing user card lost its fill').toBe(1)
        expect(projectionShadows, 'the fade overlay became a projection').toBe(0)
      })
    })
  }
})

// ── 2. Containment ────────────────────────────────────────────────────────────

/**
 * Every row root that is handed an engine-computed explicit height clips a
 * height surplus, so a measure-vs-render skew degrades to clipped content
 * instead of painting over the following row. Before this batch `assistantRoot`
 * was the last one that did not: `tool` / `thinking` / `plan` / `execute` /
 * `file-op` / `subagent` / `tool-group` were already clipped, and `diff` was
 * closed by #3438.
 *
 * `offsetHeight` cannot see this. The root is GIVEN its height by the render
 * side's own formula, so the height contract compares two formulas and reads
 * clean either way — which is why this needs its own reading from the inside.
 */
describe('message row containment', () => {
  const transientSkew: ContractInspector = (host) => {
    const root = host.firstElementChild as HTMLElement | null
    if (!root) {
      return { rootFound: 0, clientHeight: 0, contentExtent: 0, overflowHidden: 0, paintedBelow: 0 }
    }

    // Mid-frame skew: the body has laid out, while the reserved root height
    // still reflects a shorter preceding render.
    root.style.height = '32px'
    const rootRect = root.getBoundingClientRect()

    let paintedBelow = 0
    for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      if (rect.top < rootRect.bottom) continue
      const hit = document.elementFromPoint(rect.left + 2, rect.top + 2)
      if (hit instanceof Element && (element === hit || element.contains(hit))) {
        paintedBelow += 1
        break
      }
    }

    return {
      rootFound: 1,
      clientHeight: root.clientHeight,
      contentExtent: root.scrollHeight,
      overflowHidden: getComputedStyle(root).overflow === 'hidden' ? 1 : 0,
      paintedBelow
    }
  }

  for (const [label, item] of [
    ['assistant', assistantMessage],
    ['thought', thoughtMessage]
  ] as const) {
    it(`${label} root contains a body taller than its reserved height`, async () => {
      const reading = await renderAndMeasureUnit(
        messageUnitDef,
        item,
        makeContractCtx({ width: NARROW_WIDTH }),
        transientSkew
      )
      expectHeightMatch(`${label} transient skew (before probe)`, reading)

      const { rootFound, clientHeight, contentExtent, overflowHidden, paintedBelow } =
        reading.inspected

      expect(rootFound, `${label}: containment inspector found no root`).toBe(1)
      expect(
        contentExtent,
        `${label}: transient control did not overflow — scrollHeight=${contentExtent}px clientHeight=${clientHeight}px, so the assertions below prove nothing`
      ).toBeGreaterThan(clientHeight)
      expect(overflowHidden, `${label} root does not clip a transient height surplus`).toBe(1)
      expect(paintedBelow, `${label} body stayed paint-hit-testable below its reserved root`).toBe(0)
    })
  }

  /**
   * `cardRoot` is the other root handed an engine height, and a scan for
   * `height: <X>Vars.height` finds it with no class-level `overflow` — the same
   * shape `assistantRoot` had. It does NOT get the same guard, because measuring
   * says it does not need one: `UserMessageCard` writes `overflow-y` inline on
   * every render (`hidden` while collapsed or animating, `auto` when expanded at
   * rest), and a non-visible `overflow-y` makes `overflow-x` compute to `auto`
   * rather than stay `visible`. Both branches contain.
   *
   * Adding `overflow: hidden` here because the sibling rows have it would be a
   * consistency argument, not a defect argument — #3438 is the precedent for
   * measuring first. What the guarantee lacks is not a rule but a reading: it
   * currently rests on an inline style a refactor could drop silently. So the
   * containment is asserted instead, and the mutation that removes that inline
   * style turns this red.
   */
  it('user card contains a transient surplus without a class-level overflow', async () => {
    const reading = await renderAndMeasureUnit(
      messageUnitDef,
      userMessageOverflowing,
      makeContractCtx({ width: NARROW_WIDTH }),
      (host) => {
        // ⚠️ 要夹住溢出的是**气泡**,不是行根。附件条挂在气泡外面之后,行根成了两者的容器
        // (#5269),它本来就不该有 overflow —— 量它等于量错了对象。
        const root = host.querySelector<HTMLElement>('[data-user-card]')
        if (!root) {
          return {
            rootFound: 0,
            clippedAxes: 0,
            clientHeight: 0,
            contentExtent: 0,
            paintedBelow: 0
          }
        }
        const style = getComputedStyle(root)
        const clippedAxes = [style.overflowX, style.overflowY].filter(
          (axis) => axis !== 'visible'
        ).length

        root.style.height = '32px'
        const rootRect = root.getBoundingClientRect()
        let paintedBelow = 0
        for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
          const rect = element.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) continue
          if (rect.top < rootRect.bottom) continue
          const hit = document.elementFromPoint(rect.left + 2, rect.top + 2)
          if (hit instanceof Element && (element === hit || element.contains(hit))) {
            paintedBelow += 1
            break
          }
        }

        return {
          rootFound: 1,
          clippedAxes,
          clientHeight: root.clientHeight,
          contentExtent: root.scrollHeight,
          paintedBelow
        }
      }
    )
    expectHeightMatch('user card transient skew (before probe)', reading)

    const { rootFound, clippedAxes, clientHeight, contentExtent, paintedBelow } = reading.inspected

    expect(rootFound, 'user card: containment inspector found no root').toBe(1)
    expect(
      contentExtent,
      `user card: transient control did not overflow — scrollHeight=${contentExtent}px clientHeight=${clientHeight}px, so the assertions below prove nothing`
    ).toBeGreaterThan(clientHeight)
    expect(clippedAxes, 'user card left an axis at overflow: visible').toBe(2)
    expect(paintedBelow, 'user card body stayed paint-hit-testable below its reserved root').toBe(0)
  })
})

// ── Thinking label keeps its words when the gist does not fit ─────────────────

/**
 * 2026-10-02 phone (row 292px, header 260px): a finished thinking row read 「Th…」 —
 * the label and the gist both shrank by their natural widths, and a long gist is the
 * bigger of the two, so the label lost nearly everything. The gist is the part that
 * gives way; the label only shrinks once the gist is gone.
 */
describe('thinking row: the gist gives way before the label', () => {
  it('a long gist at a phone-width row leaves the label whole', async () => {
    const longGist: ChatThinking = {
      ...thinkingDone,
      id: 'msg-thinking-long-gist',
      durationMs: 0,
      text: 'Now write a 25-line poem about the sea, one line per line. Just output it in my reply, the user said write.'
    }
    const reading = await renderAndMeasureUnit(
      thinkingUnitDef,
      longGist,
      makeContractCtx({ width: 292 }),
      (host) => {
        const label = host.querySelector('[data-slot="collapse-header"] > span') as HTMLElement | null
        const gist = label?.nextElementSibling as HTMLElement | null
        return {
          labelFound: label ? 1 : 0,
          labelShort: label ? labelShortfall(label) : -1,
          gistClipped: gist ? gist.scrollWidth - gist.clientWidth : -1
        }
      }
    )
    expectHeightMatch('thinking long gist', reading)
    const { labelFound, labelShort, gistClipped } = reading.inspected
    expect(labelFound, 'no label span under the collapse header').toBe(1)
    // Positive control: the gist really is too long for the row, otherwise nothing competes.
    expect(gistClipped, 'the gist fit, so this row proves nothing').toBeGreaterThan(0)
    // Not "≤ 1px": a sub-pixel share is already enough for the ellipsis to paint, and
    // scrollWidth rounds it away (desktop 2026-10-16, 「短暂思…」). See `labelShortfall`.
    expect(labelShort, `label ${labelShort}px short of its own width while the gist still had room to give`).toBeLessThanOrEqual(0.01)
  })
})
