/** @jsxImportSource solid-js */
/**
 * Contracts for typeset LaTeX in the transcript — the block form and the inline
 * form, read off real Chromium layout.
 *
 * ── What could actually go wrong here ────────────────────────────────────────
 *
 * Not "does KaTeX work". KaTeX works. The three failures this block can produce
 * are all failures of AGREEMENT between the engine's reserved geometry and the
 * geometry the browser ends up painting:
 *
 *   1. The reserved band is shorter than the formula, so glyphs are clipped or
 *      spill into the neighbouring line. A fraction is about twice body height,
 *      so the wrong answer here is the natural one.
 *   2. An inline formula taller than the type line: the text run it sits in is
 *      measured offscreen, so the line box must grow there exactly as it does
 *      where the run is painted.
 *   3. The formula renders as something other than a formula — the state this
 *      block replaced, where inline math was a `∑ math` chip and display math
 *      was a line of literal LaTeX. Every geometry reading above stays green in
 *      that world, because a chip has a perfectly consistent width and height.
 *
 * So the readings below are: heights, edges, and one liveness check that what
 * is being measured is a typeset formula at all.
 *
 * ── Making the instrument prove itself ───────────────────────────────────────
 *
 * A containment detector that never reports an escape is indistinguishable from
 * one that cannot. It therefore also runs against a deliberately broken layout
 * in the same file: a frame forced back down to the type line-height as if the
 * formula's height had been ignored. That control must report the fault. That
 * is the difference between "nothing escaped" and "nothing was looked at".
 */

import { mathBlockDef } from '@session-chat/components/rows/markdown/math/math.def'
import { mathContent } from '@session-chat/components/rows/markdown/math/math.css'
import { htmlBlockDef } from '@session-chat/components/rows/markdown/html/html.def'
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext'
import { CachesContext } from '@session-chat/components/contexts/CachesContext'
import { createChatCaches } from '@session-chat/core/caches'
import type { Measured } from '@session-chat/core/define'
import type { HtmlLeafLayout } from '@session-chat/core/layout/layout-types'
import type { HtmlBlock, MathBlock } from '@session-chat/core/markdown/document'
import { parseMarkdownToBlocks } from '@session-chat/core/markdown/parse'
import { DEFAULT_THEME } from '@session-chat/core/theme'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compactLineHeight,
  makeContractCtx,
  renderAndMeasureBlock,
  type ContractInspector,
  type HeightContractReading
} from '@session-chat/tests/contract'

const WIDTH = 420
/** Narrow enough that a modest formula is already wider than the column. */
const NARROW = 120

/** One line of a text run: the compact rhythm at the body size, rounded up as `measure()` rounds. */
const typeLine = (): number => Math.ceil(compactLineHeight(DEFAULT_THEME.fonts.body.size))

function expectHeightMatch(layer: string, reading: HeightContractReading): void {
  const delta = reading.dom - reading.computed
  expect(
    reading.dom,
    `${layer} height mismatch: engine=${reading.computed}px DOM=${reading.dom}px delta=${delta}px`
  ).toBe(reading.computed)
}

// ── Block math ────────────────────────────────────────────────────────────────

const SIMPLE: MathBlock = { kind: 'math', id: 'math#simple', tex: 'E = mc^2' }
/** Fraction over a radical: height no formula predicts. */
const TALL: MathBlock = {
  kind: 'math',
  id: 'math#tall',
  tex: '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}'
}
/** Nested fractions — taller again, and the case an aspect-ratio box would crop. */
const TALLER: MathBlock = {
  kind: 'math',
  id: 'math#taller',
  tex: '\\frac{\\frac{a}{b}}{\\frac{c}{d}} + \\sum_{i=1}^{n} \\frac{x_i^2}{\\sqrt{y_i}}'
}
const BROKEN: MathBlock = { kind: 'math', id: 'math#broken', tex: '\\frac{1}{' }

/**
 * Vertical containment of the typeset content inside its reserved frame, plus
 * the liveness reading that there IS typeset content.
 *
 * The subject is the `mathContent` span, not the `.katex` root inside it. That
 * span is the element the measurement tier sized, and `.katex` reads shorter
 * than the box it occupies — KaTeX positions its rows with struts and vlists
 * whose ink extends past the root's own border box. Reading `.katex` here would
 * under-report escape by a couple of px in exactly the situation this check
 * exists to catch (measured: a 24px formula crammed into a 20px band reads as
 * escaping 0.9px through `.katex`, and 2px through the measured span).
 */
const inspectFormula: ContractInspector = (host) => {
  const frame = host.firstElementChild as HTMLElement | null
  const content = host.querySelector<HTMLElement>(`.${mathContent}`)
  if (!frame) return { frameFound: 0, katexRoots: 0, overTop: 0, overBottom: 0, contentWidth: 0 }

  const frameBox = frame.getBoundingClientRect()
  const contentBox = (content ?? frame).getBoundingClientRect()

  return {
    frameFound: 1,
    katexRoots: host.querySelectorAll('.katex').length,
    // Positive means the formula pokes out of the box reserved for it.
    overTop: Math.max(0, frameBox.top - contentBox.top),
    overBottom: Math.max(0, contentBox.bottom - frameBox.bottom),
    contentWidth: contentBox.width
  }
}

describe('display math reserves the box it actually typesets into', () => {
  it.each([
    { label: 'simple', block: SIMPLE, width: WIDTH },
    { label: 'fraction over a radical', block: TALL, width: WIDTH },
    { label: 'nested fractions and a summation', block: TALLER, width: WIDTH },
    { label: 'over-wide, scroll track reserved', block: TALLER, width: NARROW }
  ])('$label', async ({ label, block, width }) => {
    const reading = await renderAndMeasureBlock(
      mathBlockDef,
      block,
      makeContractCtx({ width }),
      inspectFormula
    )

    expectHeightMatch(`display math (${label})`, reading)
    expect(reading.inspected.frameFound, `${label}: no BlockFrame rendered`).toBe(1)
    expect(
      reading.inspected.katexRoots,
      `${label}: rendered no .katex root — the box may be right and the content still not a formula`
    ).toBeGreaterThan(0)
    expect(
      reading.inspected.overTop,
      `${label}: formula overhangs the reserved frame by ${reading.inspected.overTop}px at the top`
    ).toBeLessThanOrEqual(0.5)
    expect(
      reading.inspected.overBottom,
      `${label}: formula overhangs the reserved frame by ${reading.inspected.overBottom}px at the bottom`
    ).toBeLessThanOrEqual(0.5)
  })

  it('reserves more height for a taller formula than for a short one', async () => {
    const short = mathBlockDef.measure(SIMPLE, makeContractCtx({ width: WIDTH }))
    const tall = mathBlockDef.measure(TALLER, makeContractCtx({ width: WIDTH }))
    // Without this the whole design could be a constant, and every containment
    // reading above would still pass on a generously oversized fixed box.
    expect(
      tall.height,
      `nested fractions reserved ${tall.height}px, the same as a one-line formula`
    ).toBeGreaterThan(short.height)
  })

  it('keeps a formula that does not parse visible instead of dropping it', async () => {
    const reading = await renderAndMeasureBlock(
      mathBlockDef,
      BROKEN,
      makeContractCtx({ width: WIDTH }),
      (host) => ({ text: host.textContent?.includes('frac') ? 1 : 0 })
    )
    expectHeightMatch('display math (unparseable)', reading)
    expect(reading.computed, 'an unparseable formula collapsed to nothing').toBeGreaterThan(0)
    expect(reading.inspected.text, 'an unparseable formula lost its source').toBe(1)
  })
})

// ── Inline math ───────────────────────────────────────────────────────────────

function inlineBlock(markdown: string): HtmlBlock {
  const [block] = parseMarkdownToBlocks('inline-math', markdown)
  if (block?.kind !== 'html') throw new Error(`expected one text run for ${markdown}`)
  return block
}

const SHORT_INLINE = inlineBlock('Energy is $E = mc^2$ in this frame.')
// Nested fractions: typeset taller than the 21.7px type line (14px × 1.55), so the
// line has to grow by several px. A single fraction only needs a few, which is too near the noise
// floor for the falsification control below to mean much.
const TALL_INLINE = inlineBlock('The ratio $\\frac{\\frac{a}{b}}{\\frac{c}{d}}$ closes the integral.')
const PLAIN_INLINE = inlineBlock('The ratio x closes the integral.')

/**
 * The painted run against its frame: the run's own height (what the frame must
 * equal) and how far the typeset formula pokes out of the frame. The formula is
 * read through KaTeX's `.base` boxes — inline-blocks sized by struts, so they
 * cover the ink that the inline `.katex` span under-reports.
 */
const inspectRun: ContractInspector = (host) => {
  const frame = host.querySelector<HTMLElement>('[data-block-id]')
  const run = frame?.querySelector<HTMLElement>('.gg-md')
  const bases = Array.from(host.querySelectorAll<HTMLElement>('.katex .base'))
  if (!frame || !run || bases.length === 0) return { found: 0, runHeight: 0, escape: 0, literalTex: 0 }
  const frameBox = frame.getBoundingClientRect()
  const top = Math.min(...bases.map((base) => base.getBoundingClientRect().top))
  const bottom = Math.max(...bases.map((base) => base.getBoundingClientRect().bottom))
  // Text outside the typeset formula: the pre-fix state painted the source (or
  // a '∑ math' chip) where the formula should be.
  const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT)
  let outside = ''
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('.katex')) outside += node.textContent
  }
  return {
    found: 1,
    // Rounded up as `measure()` rounds; KaTeX struts leave a fractional box.
    runHeight: Math.ceil(run.getBoundingClientRect().height),
    escape: Math.max(0, frameBox.top - top, bottom - frameBox.bottom),
    literalTex: /mc\^2|∑ math|\\frac/.test(outside) ? 1 : 0,
  }
}

/**
 * Mount a measured html block directly. Direct rather than through
 * `renderAndMeasureBlock` because the falsification control paints a layout
 * that `measure()` would never produce.
 */
async function mountHtml(node: Measured<HtmlLeafLayout>): Promise<Record<string, number>> {
  const host = document.createElement('div')
  host.dataset.contractHost = ''
  host.style.width = `${WIDTH}px`
  host.style.position = 'relative'
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <ThemeContext.Provider value={() => DEFAULT_THEME}>
        <CachesContext.Provider value={createChatCaches()}>
          <htmlBlockDef.Render node={node} />
        </CachesContext.Provider>
      </ThemeContext.Provider>
    ),
    host
  )
  await document.fonts.ready
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  try {
    return inspectRun(host)
  } finally {
    dispose()
    host.remove()
  }
}

afterEach(() => {
  document.querySelectorAll('[data-contract-host]').forEach((el) => el.remove())
})

describe('inline math is typeset, and the line it sits on holds it', () => {
  it.each([
    { label: 'short formula', block: SHORT_INLINE },
    { label: 'nested fractions', block: TALL_INLINE },
  ])('$label: typeset, and the frame is the run’s painted height', async ({ label, block }) => {
    const reading = await renderAndMeasureBlock(htmlBlockDef, block, makeContractCtx({ width: WIDTH }), inspectRun)

    expect(reading.inspected.found, `${label}: no typeset formula painted`).toBe(1)
    expect(reading.inspected.literalTex, `${label}: the LaTeX source (or a placeholder) was painted as text`).toBe(0)
    expectHeightMatch(`inline math (${label})`, { ...reading, dom: reading.inspected.runHeight })
    expect(
      reading.inspected.escape,
      `${label}: formula overhangs its frame by ${reading.inspected.escape}px`
    ).toBeLessThanOrEqual(0.5)
  })

  it('grows the line for a formula taller than the type line, and only then', () => {
    const ctx = makeContractCtx({ width: WIDTH })
    // One line of plain text reserves exactly the type line: no band is added
    // when nothing asks for extra height.
    expect(htmlBlockDef.measure(PLAIN_INLINE, ctx).height).toBe(typeLine())
    expect(
      htmlBlockDef.measure(TALL_INLINE, ctx).height,
      'a fraction was squeezed into the body line-height'
    ).toBeGreaterThan(typeLine())
  })

  it('CONTROL: the containment detector reports a frame forced back to the type line', async () => {
    const measured = htmlBlockDef.measure(TALL_INLINE, makeContractCtx({ width: WIDTH }))
    const honest = await mountHtml(measured)
    const forced = await mountHtml({
      ...measured,
      height: typeLine(),
      layout: { ...measured.layout, height: typeLine() },
    })

    expect(honest.found, 'the honest layout was not even readable').toBe(1)
    expect(honest.escape, 'the honest frame already lets the formula escape').toBeLessThanOrEqual(0.5)
    expect(
      forced.escape,
      'a fraction crammed into the type line-height read as contained — the containment check is blind'
    ).toBeGreaterThan(1)
  })
})
