/** @jsxImportSource solid-js */
/**
 * Contracts for the markdown block kinds: `code` / `html` / `math` / `mermaid`.
 *
 * One file per batch, following `card-rows.contract.test.tsx` and
 * `message-rows.contract.test.tsx` — the shared `height.contract.test.tsx` and
 * `message-markdown.contract.test.tsx` are magnets every batch would edit.
 *
 * These are the WHOLE set: `BLOCK_REGISTRY` is typed
 * `Record<Block['kind'], BlockDef>`, so the compiler — not a hand-written
 * inventory — is what says nothing else exists. Text of every kind (paragraphs,
 * headings, lists, quotes, rules, tables, inline math) is one `html` run styled
 * by the shared `.gg-md` typography; the fixtures below read each of those
 * shapes, because the kind alone no longer says which one is under the ruler.
 *
 * ── Establishing the subject before counting anything ──────────────────────
 *
 * "Does this block draw a card?" is only answerable once you fix WHOSE chrome
 * you are counting. Every reading below is therefore taken at two apertures
 * with one ruler:
 *
 *   subtree — the BlockFrame and every rendered descendant
 *   root    — the BlockFrame and its DIRECT children only
 *
 * The two disagree, and that disagreement is the evidence: a rich run reads
 * filled, rounded elements in the subtree and zero at the root, because those
 * are the inline-code and mention chips — content the markdown owns, not a
 * container the run drew around itself. A table reads a bordered cell grid in
 * the subtree and nothing at the root.
 *
 * ── Why nothing here loses its container ───────────────────────────────────
 *
 * Agent output reads as one column; a container stays exactly where it carries
 * meaning. `code` and `mermaid` each draw ONE bordered, unfilled surface that
 * marks where the agent's prose stops and a verbatim artifact starts; `html`
 * and `math` draw no container at all — a quote's rail, a rule and a table's
 * grid are the content itself. So the inventory is two-sided and both sides
 * can fail: an added card on a text run or a formula goes red, and a stripped
 * surface on code/mermaid goes red too.
 *
 * `math` is on the undecorated side deliberately. A displayed formula is not an
 * embedded artifact quoted out of some other language the way a code block or a
 * diagram is; it is the sentence continuing in mathematical notation, and every
 * typeset medium sets it bare and centred in the text column.
 *
 * ── Height: the run, not the frame ─────────────────────────────────────────
 *
 * A BlockFrame is GIVEN its height as an inline style, so the frame's own box
 * agrees with `measure()` however the content inside lands. For an html run the
 * reading that can disagree is the run element's box, and that is the one
 * `expectHeightMatch` compares.
 */

import { pblock } from '@session-chat/components/engine/block-frame.css'
import { codeBlockDef } from '@session-chat/components/rows/markdown/code/code.def'
import { codeLine } from '@session-chat/components/rows/markdown/code/code.css'
import { htmlBlockDef } from '@session-chat/components/rows/markdown/html/html.def'
import { mathBlockDef } from '@session-chat/components/rows/markdown/math/math.def'
import { mathContent } from '@session-chat/components/rows/markdown/math/math.css'
import { mermaidBlockDef } from '@session-chat/components/rows/markdown/mermaid/mermaid.def'
import { readMermaidTheme } from '@session-chat/core/mermaid/render'
import {
  mermaidError,
  mermaidPlaceholder,
  mermaidWrapper
} from '@session-chat/components/rows/markdown/mermaid/mermaid.css'
import { DEFAULT_CONFIG, buildChatTheme } from '@session-chat/core/config'
import { paintHighlight } from '@session-chat/core/highlight/highlighter'
import type { CommandProvider } from '@session-chat/core/markdown/command-provider'
import type { Block } from '@session-chat/core/markdown/document'
import type { MentionProvider } from '@session-chat/core/markdown/mention-provider'
import { parseMarkdownToBlocks } from '@session-chat/core/markdown/parse'
import { describe, expect, it } from 'vitest'
import {
  compactLineHeight,
  makeContractCtx,
  renderAndMeasureBlock,
  type ContractCtx,
  type ContractInspector,
  type HeightContractReading
} from './contract'

const WIDE = 420
/** Narrow enough that body prose wraps to several lines rather than merely looking tight. */
const NARROW = 180

/** An html run's own box when there is one (see the header), else the frame's. */
function expectHeightMatch(layer: string, reading: HeightContractReading): void {
  const dom = reading.inspected.runHeight >= 0 ? reading.inspected.runHeight : reading.dom
  const delta = dom - reading.computed
  expect(dom, `${layer} height mismatch: engine=${reading.computed}px DOM=${dom}px delta=${delta}px`).toBe(
    reading.computed
  )
}

// ── The ruler ─────────────────────────────────────────────────────────────────

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

type Decoration = {
  count: number
  bordered: number
  edges: number
  filled: number
  rounded: number
  maxRadius: number
  projections: number
  rings: number
}

/**
 * Same ruler as `message-rows.contract.test.tsx` and the real-Electron evidence
 * spec, so these numbers and those are readings of one fact rather than two
 * scales that share a word.
 *
 * Box-shadows are split: a `0 0 0 <n>px` shadow has no offset and no blur, so
 * it is a hairline ring standing in for a border — the technique
 * ui-visual-spec §6.1 prefers because a ring does not occupy layout. Counting
 * it as a projection reports the §6 shadow ceiling as breached by something
 * that casts nothing.
 */
function decorationOf(elements: HTMLElement[]): Decoration {
  const result: Decoration = {
    count: elements.length,
    bordered: 0,
    edges: 0,
    filled: 0,
    rounded: 0,
    maxRadius: 0,
    projections: 0,
    rings: 0
  }

  for (const element of elements) {
    const style = getComputedStyle(element)

    const edges = borderEdges(style)
    result.edges += edges
    if (edges > 0) result.bordered += 1

    if (!transparent(style.backgroundColor)) result.filled += 1

    const radii = [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius
    ].map(px)
    if (radii.some((radius) => radius > 0)) {
      result.rounded += 1
      result.maxRadius = Math.max(result.maxRadius, ...radii)
    }

    if (style.boxShadow !== 'none') {
      const lengths = style.boxShadow.match(/-?[\d.]+px/g) ?? []
      const [offsetX = 0, offsetY = 0, blur = 0] = lengths.slice(0, 3).map(px)
      if (offsetX === 0 && offsetY === 0 && blur === 0) result.rings += 1
      else result.projections += 1
    }
  }

  return result
}

const rendered = (element: HTMLElement): boolean => {
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

const EMPTY_DECORATION: Decoration = {
  count: 0,
  bordered: 0,
  edges: 0,
  filled: 0,
  rounded: 0,
  maxRadius: 0,
  projections: 0,
  rings: 0
}

/** Reads the same decoration twice: whole subtree, then direct children only. */
const inventory =
  (theme: 'light' | 'dark'): ContractInspector =>
  (host) => {
    if (theme === 'dark') host.classList.add('emdark')
    const frame = host.firstElementChild as HTMLElement | null
    if (!frame) return reportInventory(null, EMPTY_DECORATION, EMPTY_DECORATION)

    const subtree = decorationOf(
      [frame, ...Array.from(frame.querySelectorAll<HTMLElement>('*'))].filter(rendered)
    )
    const root = decorationOf(
      [
        frame,
        ...Array.from(frame.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
      ].filter(rendered)
    )

    return reportInventory(frame, subtree, root)
  }

function reportInventory(
  frame: HTMLElement | null,
  subtree: Decoration,
  root: Decoration
): Record<string, number> {
  return {
    frameFound: frame ? 1 : 0,
    isBlockFrame: frame?.classList.contains(pblock) ? 1 : 0,
    subCount: subtree.count,
    subBordered: subtree.bordered,
    subFilled: subtree.filled,
    subRounded: subtree.rounded,
    subRings: subtree.rings,
    subProjections: subtree.projections,
    rootCount: root.count,
    rootBordered: root.bordered,
    rootEdges: root.edges,
    rootFilled: root.filled,
    rootRounded: root.rounded,
    rootMaxRadius: root.maxRadius,
    rootProjections: root.projections
  }
}

/**
 * Does anything escape the frame, and could this probe have seen it if it did?
 *
 * `candidates` and `inViewport` are reported alongside `hits` on purpose.
 * `elementFromPoint` answers null for coordinates outside the viewport, so a
 * bare `hits === 0` is indistinguishable from a loop that had nothing to test
 * or a hit-test that could never land. Only `hits === 0` while `inViewport > 0`
 * is a negative reading; everything else is "not measured".
 */
function escapeReading(frame: HTMLElement) {
  const rect = frame.getBoundingClientRect()
  const viewportWidth = document.documentElement.clientWidth
  const viewportHeight = document.documentElement.clientHeight

  let belowCandidates = 0
  let belowInViewport = 0
  let belowHits = 0
  let besideCandidates = 0
  let besideInViewport = 0
  let besideHits = 0

  // Elements, and each laid-out line of text: a text run has no element per line,
  // so its wrapped lines are only visible to the probe as text rects.
  const candidates: Array<{ box: DOMRect; owner: Element }> = Array.from(
    frame.querySelectorAll<HTMLElement>('*')
  ).map((element) => ({ box: element.getBoundingClientRect(), owner: element }))
  const walker = document.createTreeWalker(frame, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement) continue
    range.selectNodeContents(node)
    for (const box of Array.from(range.getClientRects())) candidates.push({ box, owner: node.parentElement })
  }

  for (const { box, owner } of candidates) {
    if (box.width === 0 && box.height === 0) continue
    const x = box.left + 2
    const y = box.top + 2
    const inViewport = x >= 0 && y >= 0 && x < viewportWidth && y < viewportHeight
    const hits = (): boolean => {
      const hit = document.elementFromPoint(x, y)
      return hit instanceof Element && (owner === hit || owner.contains(hit))
    }

    if (box.top >= rect.bottom) {
      belowCandidates += 1
      if (inViewport) {
        belowInViewport += 1
        if (hits()) belowHits += 1
      }
    }
    if (box.left >= rect.right) {
      besideCandidates += 1
      if (inViewport) {
        besideInViewport += 1
        if (hits()) besideHits += 1
      }
    }
  }

  return {
    belowCandidates,
    belowInViewport,
    belowHits,
    besideCandidates,
    besideInViewport,
    besideHits
  }
}

/** `skewTo` reproduces a mid-frame measure-vs-render desync; null reads the settled state. */
const escapes =
  (skewTo: number | null, dropContainment = false): ContractInspector =>
  (host) => {
    const frame = host.firstElementChild as HTMLElement | null
    if (!frame) {
      return {
        frameFound: 0,
        belowCandidates: 0,
        belowInViewport: 0,
        belowHits: 0,
        besideCandidates: 0,
        besideInViewport: 0,
        besideHits: 0
      }
    }
    if (dropContainment) frame.style.contain = 'none'
    if (skewTo !== null) frame.style.height = `${skewTo}px`
    return { frameFound: 1, ...escapeReading(frame) }
  }

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Overflows a 180px frame horizontally while staying inside the test viewport. */
const WIDE_CELL = 'y'.repeat(48)

type Fixture = {
  label: string
  // oxlint-disable-next-line typescript/no-explicit-any -- BlockDef is generic per kind; safe at the fixture boundary
  def: any
  block: Block
  prime?: (ctx: ContractCtx) => void | Promise<unknown>
}

const fileMentions: MentionProvider = { resolve: (token) => ({ id: token, label: token, kind: 'file' }) }
const anyCommand: CommandProvider = { resolve: (name) => ({ name }) }

/** One text run, parsed the way the transcript parses it. */
function run(label: string, id: string, markdown: string): Fixture {
  const blocks = parseMarkdownToBlocks(id, markdown, fileMentions, anyCommand)
  if (blocks.length !== 1 || blocks[0]!.kind !== 'html') throw new Error(`${label}: expected one text run`)
  return { label, def: htmlBlockDef, block: blocks[0]! }
}

const htmlBody = run('text body', 'md-body', 'Plain prose that wraps across more than one rendered line.')
const htmlHeading = run('text h1', 'md-h1', '# A heading')
const htmlList = run('text list', 'md-list', '- A bulleted item that wraps onto a second line as well.')
const htmlQuote = run('text quote', 'md-quote', '> A quoted paragraph that wraps onto a second rendered line.')
const htmlRule = run('text rule', 'md-rule', 'Above the line.\n\n---\n\nBelow the line.')
const htmlRich = run(
  'text rich-inline',
  'md-rich',
  'Rich prose with `inlineCode()` and @file.ts and /deploy and a [link](https://example.test) wrapping onward.'
)
const htmlInlineMath = run(
  'text inline math',
  'md-inline-math',
  'The ratio $\\frac{\\frac{a}{b}}{\\frac{c}{d}}$ wraps with the rest of this sentence at either width.'
)
const htmlTableFits = run('table fitting', 'md-table', '| A | B |\n| --- | --- |\n| 1 | 2 |')
const htmlTableOverflowing = run(
  'table overflowing',
  'md-table-wide',
  `| ${WIDE_CELL} | Beta | Gamma | Delta |\n| --- | --- | --- | --- |\n| ${WIDE_CELL} | b | c | d |\n| e | f | g | h |`
)

const CODE_SOURCE = `const a = 1;\nconst b = "${WIDE_CELL}";\nconst c = 2;`

const codePlain: Fixture = {
  label: 'code unhighlighted',
  def: codeBlockDef,
  block: { kind: 'code', id: 'md#5', code: CODE_SOURCE }
}

const codeHighlighted: Fixture = {
  label: 'code highlighted',
  def: codeBlockDef,
  block: { kind: 'code', id: 'md#6', lang: 'typescript', code: CODE_SOURCE },
  // Warm the highlight cache so Render takes its synchronous fast-path; the
  // idle path would otherwise leave every reading in the unhighlighted state.
  prime: (ctx) => {
    ctx.caches.highlight(CODE_SOURCE, 'typescript')
  }
}

/**
 * Mermaid renders one of three things inside its wrapper: a placeholder while
 * the diagram is pending, an `<svg>` once it resolves, or an error label when
 * the source will not render. One fixture per state: the drawn one is primed
 * into the cache so the block takes the synchronous peek path; the pending one
 * is not primed, so it may still be the placeholder or may already be drawn
 * when read — the assertion there is "exactly one content state rendered".
 *
 * The drawn source is the single-line `graph TD; A-->B;` agents write (#7072):
 * valid mermaid that the old transcript renderer rejected.
 */
const MERMAID_ONE_LINE = 'graph TD; A-->B;'

const mermaidPending: Fixture = {
  label: 'mermaid unresolved',
  def: mermaidBlockDef,
  block: { kind: 'mermaid', id: 'md#7', source: MERMAID_ONE_LINE }
}

const mermaidDrawn: Fixture = {
  label: 'mermaid drawn',
  def: mermaidBlockDef,
  block: { kind: 'mermaid', id: 'md#9', source: MERMAID_ONE_LINE },
  prime: (ctx) => ctx.caches.renderMermaid(MERMAID_ONE_LINE, readMermaidTheme())
}

const mermaidBroken: Fixture = {
  label: 'mermaid unrenderable source',
  def: mermaidBlockDef,
  block: { kind: 'mermaid', id: 'md#8', source: '!!! not a diagram !!!' }
}

const mathFits: Fixture = {
  label: 'math fitting',
  def: mathBlockDef,
  block: { kind: 'math', id: 'md#12', tex: '\\frac{\\sqrt{\\pi}}{2}' }
}

/**
 * Wider than NARROW once typeset, so the scroll branch of the block is the one
 * under the ruler. Its reserved height differs from the fitting case by the
 * scroll track, which is 0 on overlay-scrollbar platforms and ~15px here.
 */
const mathOverflowing: Fixture = {
  label: 'math overflowing',
  def: mathBlockDef,
  block: {
    kind: 'math',
    id: 'md#13',
    tex: '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2} \\quad \\text{and} \\quad \\sum_{i=1}^{n} \\frac{x_i^2}{\\sqrt{y_i}} = \\alpha\\beta\\gamma'
  }
}

async function read(
  fixture: Fixture,
  width: number,
  inspect: ContractInspector,
  theme = buildChatTheme(DEFAULT_CONFIG)
): Promise<HeightContractReading> {
  const ctx = makeContractCtx({ width, theme })
  await fixture.prime?.(ctx)
  return renderAndMeasureBlock(fixture.def, fixture.block, ctx, (host) => ({
    ...inspect(host),
    runHeight: paintedRunHeight(host)
  }))
}

/**
 * The run's painted height, rounded up the way `measure()` rounds: a table
 * border or a KaTeX strut leaves a fractional box, and `offsetHeight` rounds
 * that to the nearest pixel where the reserved frame rounds it up.
 */
function paintedRunHeight(host: HTMLElement): number {
  const run = host.querySelector<HTMLElement>('.gg-md')
  return run ? Math.ceil(run.getBoundingClientRect().height) : -1
}

// ── 1. Decoration inventory, at both apertures ────────────────────────────────

/** Draw no container of their own — a card added back to any of these goes red. */
const undecorated = [
  htmlBody,
  htmlHeading,
  htmlList,
  htmlQuote,
  htmlRule,
  htmlRich,
  htmlInlineMath,
  htmlTableFits,
  htmlTableOverflowing,
  mathFits,
  mathOverflowing
]

/**
 * Draw exactly one bordered, unfilled surface at the block root: the boundary
 * between the agent's prose and an embedded verbatim artifact. Stripping it
 * goes red too — this list is the other half of the two-sided inventory.
 */
const surfaced = [codePlain, codeHighlighted, mermaidPending, mermaidDrawn, mermaidBroken]

describe('markdown block decoration inventory', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [WIDE, NARROW] as const) {
      describe(`${theme} @${width}px`, () => {
        for (const fixture of undecorated) {
          it(`${fixture.label} draws no container of its own`, async () => {
            const reading = await read(fixture, width, inventory(theme))
            expectHeightMatch(`${fixture.label} [${theme} ${width}]`, reading)

            const {
              frameFound,
              isBlockFrame,
              rootBordered,
              rootEdges,
              rootFilled,
              rootRounded,
              rootProjections
            } = reading.inspected

            expect(frameFound, `${fixture.label}: nothing rendered`).toBe(1)
            expect(isBlockFrame, `${fixture.label}: root is not the BlockFrame`).toBe(1)
            expect(rootBordered, `${fixture.label}: drew ${rootEdges} border edges at the root`).toBe(0)
            expect(rootFilled, `${fixture.label}: painted ${rootFilled} filled root surfaces`).toBe(0)
            expect(rootRounded, `${fixture.label}: rounded ${rootRounded} root corners`).toBe(0)
            expect(rootProjections, `${fixture.label}: cast ${rootProjections} shadows`).toBe(0)
          })
        }

        for (const fixture of surfaced) {
          it(`${fixture.label} keeps exactly one artifact surface`, async () => {
            const reading = await read(fixture, width, inventory(theme))
            expectHeightMatch(`${fixture.label} [${theme} ${width}]`, reading)

            const { rootBordered, rootEdges, rootFilled, rootMaxRadius, rootProjections } =
              reading.inspected

            // Both directions matter: 0 means the boundary between prose and a
            // verbatim artifact was deleted, >1 means a second container crept
            // in underneath it.
            expect(rootBordered, `${fixture.label} lost or duplicated its artifact surface`).toBe(1)
            expect(rootEdges, `${fixture.label}: the artifact surface is not a closed box`).toBe(4)
            // ui-visual-spec §6 expresses layer with colour, not projection. The
            // surface is an outline only — it deliberately paints no fill, so the
            // block inherits the chat background.
            expect(rootFilled, `${fixture.label}: the artifact surface started painting a fill`).toBe(0)
            expect(rootProjections, `${fixture.label}: the artifact surface started casting a shadow`).toBe(0)
            // `radiusMd`, the package surface radius (ui-visual-spec §8 gap 3).
            expect(rootMaxRadius, `${fixture.label}: left the package surface radius scale`).toBe(8)
          })
        }

        it('a rule and a quote rail are painted inside the run', async () => {
          // Guards their `undecorated` rows from being read off an empty run:
          // "no container at the root" scores the same if nothing was painted.
          const rule = await read(htmlRule, width, (host) => ({
            painted: Array.from(host.querySelectorAll('hr')).filter(rendered).length
          }))
          expect(rule.inspected.painted, 'the separator line was not painted').toBe(1)

          const quote = await read(htmlQuote, width, inventory(theme))
          expect(quote.inspected.subBordered, 'the quote rail was not painted').toBeGreaterThan(0)
        })

        it('the two apertures disagree, so the root readings mean something', async () => {
          // The whole inventory rests on subtree and root being different
          // subjects. If they ever coincide, every "0 at the root" above is
          // being read off a subject that has no inside — and the two-sided
          // inventory silently stops testing the split it was built on.
          const rich = await read(htmlRich, NARROW, inventory(theme))
          expect(
            rich.inspected.subFilled,
            'the rich run rendered no filled chip — the aperture split is untested'
          ).toBeGreaterThan(rich.inspected.rootFilled)
          expect(
            rich.inspected.subRounded,
            'the rich run rendered no rounded chip — the aperture split is untested'
          ).toBeGreaterThan(rich.inspected.rootRounded)

          const grid = await read(htmlTableOverflowing, NARROW, inventory(theme))
          expect(
            grid.inspected.subBordered,
            'the table rendered no cell grid — the aperture split is untested'
          ).toBeGreaterThan(grid.inspected.rootBordered)
        })

        it('mermaid rendered exactly one content state', async () => {
          // Guards the two mermaid rows above from being read off an empty
          // wrapper: their "one bordered surface, no fill" would score exactly
          // the same if the wrapper rendered nothing at all.
          for (const fixture of [mermaidPending, mermaidDrawn, mermaidBroken]) {
            const reading = await read(fixture, width, (host) => {
              const wrapper = host.querySelector<HTMLElement>(`.${mermaidWrapper}`)
              return {
                wrapperFound: wrapper ? 1 : 0,
                contentStates:
                  host.querySelectorAll(`.${mermaidPlaceholder}`).length +
                  host.querySelectorAll(`.${mermaidError}`).length +
                  host.querySelectorAll('svg').length,
                drawn: host.querySelectorAll(`.${mermaidWrapper} svg`).length,
                svgOutside: (() => {
                  const svg = wrapper?.querySelector('svg')
                  if (!wrapper || !svg) return -1
                  const w = wrapper.getBoundingClientRect()
                  const g = svg.getBoundingClientRect()
                  return Math.max(0, w.left - g.left, w.top - g.top, g.right - w.right, g.bottom - w.bottom)
                })()
              }
            })
            expect(reading.inspected.wrapperFound, `${fixture.label}: no mermaid wrapper`).toBe(1)
            expect(
              reading.inspected.contentStates,
              `${fixture.label}: rendered ${reading.inspected.contentStates} content states, expected exactly one`
            ).toBe(1)
            if (fixture === mermaidDrawn) {
              expect(reading.inspected.drawn, `${fixture.label}: the primed diagram is not an svg`).toBe(1)
              // A `graph TD` is taller than the 21:9 frame at the narrow width: it must be scaled into it, not spill out.
              expect(reading.inspected.svgOutside, `${fixture.label}: the svg reaches past its frame by this many px`).toBeLessThanOrEqual(1)
            }
          }
        })

        it('math rendered a typeset formula, not an empty box', async () => {
          // Same guard as the mermaid one above, for the same reason: "draws no
          // container" scores identically on a block that drew nothing at all,
          // and that is precisely the state this block kind replaced.
          for (const fixture of [mathFits, mathOverflowing]) {
            const reading = await read(fixture, width, (host) => ({
              contentBoxes: host.querySelectorAll(`.${mathContent}`).length,
              katexRoots: host.querySelectorAll('.katex').length
            }))
            expect(reading.inspected.contentBoxes, `${fixture.label}: no measured math box`).toBe(1)
            expect(
              reading.inspected.katexRoots,
              `${fixture.label}: the math box holds no typeset formula`
            ).toBeGreaterThan(0)
          }
          const inline = await read(htmlInlineMath, width, (host) => ({
            katexRoots: host.querySelectorAll('.katex').length
          }))
          expect(inline.inspected.katexRoots, 'the inline formula was not typeset').toBe(1)
        })

        it('inline chips ring, they do not project', async () => {
          // The mention chip's `box-shadow` is a `0 0 0 1px` hairline. §6 caps
          // projections, not rings; counting it as a projection reports the
          // ceiling breached by something that casts nothing. The ring count
          // must stay non-zero or this split is being asserted about an empty set.
          const reading = await read(htmlRich, NARROW, inventory(theme))
          expect(reading.inspected.subRings, 'no hairline ring rendered — the split is untested').toBeGreaterThan(0)
          expect(reading.inspected.subProjections, 'an inline chip started casting a projection').toBe(0)
        })
      })
    }
  }
})

// ── 2. Containment ────────────────────────────────────────────────────────────

/**
 * A markdown block is not clipped by `overflow`. `pblock` declares
 * `overflow: visible`; what actually holds a measure-vs-render surplus inside
 * the frame is its paint containment (`contain: paint`).
 *
 * A style-level reading only says the property is set, not that it clips —
 * so it is read by hitting what escapes, and it is shown to be the mechanism
 * by taking the property away. The last test in this
 * block does exactly that, and is the reason the zeros above are readings
 * rather than an untested assumption.
 *
 * `code` and `mermaid` do not depend on it: each fills its frame with an inset
 * surface that clips on its own. A text run has no such surface, so for the
 * most common block kind in the transcript this is the only thing standing
 * between a transient desync and text painted over the next block.
 */
describe('markdown block containment', () => {
  const canOverflowDownward = [
    { fixture: htmlBody, width: NARROW },
    { fixture: htmlList, width: NARROW },
    { fixture: htmlQuote, width: NARROW },
    { fixture: htmlRich, width: NARROW },
    { fixture: htmlInlineMath, width: NARROW },
    { fixture: htmlTableFits, width: WIDE },
    { fixture: htmlTableOverflowing, width: NARROW },
    { fixture: codePlain, width: WIDE },
    { fixture: codeHighlighted, width: WIDE },
    // Math is NOT structurally immune the way mermaid is, even though it too
    // fills its frame with an inset surface. Measured, not reasoned: the inset
    // box shrinks with a skewed frame while the typeset spans inside keep their
    // own size, so they end up below it and have to be clipped rather than
    // merely displaced. This is the same footing as text and code.
    { fixture: mathFits, width: WIDE },
    { fixture: mathOverflowing, width: NARROW }
  ]

  for (const { fixture, width } of canOverflowDownward) {
    it(`${fixture.label} holds a transient height surplus inside the frame`, async () => {
      const reading = await read(fixture, width, escapes(16))
      const { belowCandidates, belowInViewport, belowHits } = reading.inspected

      expect(
        belowCandidates,
        `${fixture.label}: the skew produced nothing below the frame, so the assertion below proves nothing`
      ).toBeGreaterThan(0)
      expect(
        belowInViewport,
        `${fixture.label}: every candidate fell outside the viewport, where elementFromPoint always answers null`
      ).toBeGreaterThan(0)
      expect(
        belowHits,
        `${fixture.label}: ${belowHits} element(s) stayed paint-hit-testable below the frame`
      ).toBe(0)
    })
  }

  it('the settled state overflows nothing at all', async () => {
    for (const { fixture, width } of canOverflowDownward) {
      const reading = await read(fixture, width, escapes(null))
      expect(
        reading.inspected.belowCandidates,
        `${fixture.label}: settled layout already put content below its own frame`
      ).toBe(0)
    }
  })

  it('an overflowing table scrolls inside its own box, not past the frame', async () => {
    // `HeightContractReading.spill` compares bounding-rect edges, which a scroll
    // container's clipped children still report in full — that is not an
    // escape. The hit-test is the reading that separates "sticks out of the
    // box" from "painted outside the box"; the scroll box is what lets a reader
    // still reach the clipped columns.
    const reading = await read(htmlTableOverflowing, NARROW, (host) => {
      const scroller = host.querySelector<HTMLElement>('.gg-md-table-scroll')
      return {
        ...escapes(null)(host),
        scrollable: scroller && scroller.scrollWidth > scroller.clientWidth ? 1 : 0
      }
    })
    const { besideCandidates, besideInViewport, besideHits, scrollable } = reading.inspected
    expect(besideCandidates, 'the table did not overflow sideways, so this proves nothing').toBeGreaterThan(0)
    expect(besideInViewport, 'every sideways candidate fell outside the viewport').toBeGreaterThan(0)
    expect(besideHits, `${besideHits} cell(s) painted outside the frame`).toBe(0)
    expect(scrollable, 'the clipped columns cannot be scrolled into view').toBe(1)
  })

  it('a wide table fades at its right edge while more columns are to the right, and not at the end or when it fits', async () => {
    // owner 2026-10-02: the clipped columns read as cut off — nothing says the box scrolls. The fade is a
    // scroll-driven animation in markdown.css (one rule for this transcript's scroll box and Streamdown's);
    // a scroll timeline only resolves on the next frame, so this mounts its own box instead of the sync inspector.
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const faded = (el: HTMLElement) => {
      const style = getComputedStyle(el)
      const value = style.maskImage || style.getPropertyValue('-webkit-mask-image')
      return Boolean(value) && value !== 'none'
    }
    const mount = (cells: string) => {
      const root = document.createElement('div')
      root.className = 'gg-md'
      root.style.width = `${NARROW}px`
      const box = document.createElement('div')
      box.className = 'gg-md-table-scroll'
      box.innerHTML = `<table><tbody><tr>${cells}</tr></tbody></table>`
      root.appendChild(box)
      document.body.appendChild(root)
      return { root, box }
    }
    const wide = mount(`<td>${WIDE_CELL}</td><td>${WIDE_CELL}</td><td>${WIDE_CELL}</td>`)
    const fits = mount('<td>a</td>')
    try {
      await frame()
      expect(wide.box.scrollWidth, 'the wide table did not overflow, so this proves nothing').toBeGreaterThan(wide.box.clientWidth)
      expect(faded(wide.box), 'no fade while columns are hidden to the right').toBe(true)
      expect(faded(fits.box), 'a table that fits still paints a fade').toBe(false)
      wide.box.scrollLeft = wide.box.scrollWidth
      await frame()
      expect(faded(wide.box), 'the fade is still there at the right end').toBe(false)
    } finally {
      wide.root.remove()
      fits.root.remove()
    }
  })

  for (const fixture of [mermaidPending, mermaidDrawn, mermaidBroken]) {
    it(`${fixture.label} has nothing that can leave the frame`, async () => {
      // Not a containment pass — a structural one. These fill their frame with
      // an inset surface, so a surplus has nowhere to go. Recorded as its own
      // assertion so that adding a non-inset child forces this to be re-read
      // instead of quietly joining the zeros above.
      const reading = await read(fixture, NARROW, escapes(16))
      expect(
        reading.inspected.belowCandidates,
        `${fixture.label}: a child now sits below the frame — containment must be measured, not assumed`
      ).toBe(0)
    })
  }

  it('paint containment is what clips a text run — remove it and the same fixture escapes', async () => {
    // The control for every zero above. Without it "0 escaped" is equally
    // consistent with a probe that can never register a hit.
    const reading = await read(htmlRich, NARROW, escapes(16, true))
    const { belowCandidates, belowInViewport, belowHits } = reading.inspected

    expect(belowCandidates, 'the control fixture produced no candidates').toBeGreaterThan(0)
    expect(belowInViewport, 'the control fixture produced no in-viewport candidates').toBeGreaterThan(0)
    expect(
      belowHits,
      'nothing escaped even with the containment removed: either the probe cannot register a hit, ' +
        'or the frame is now clipped by something else. Both mean the containment note in ' +
        'block-frame.css.ts no longer describes the mechanism — re-read it before trusting the zeros above.'
    ).toBeGreaterThan(0)
  })
})

// ── 3. The running config, not a module default ───────────────────────────────

/**
 * A text run is measured with the chat theme's body font set inline, so a host
 * that changes the body size moves the reserved height and the painted run
 * together. Its line height is not a second knob: it is `.gg-md--compact`'s
 * rhythm, the one every other compact markdown surface reads. Driven entirely
 * through the public config input — no product file is mutated to make it able
 * to fail.
 */
describe('text run type parity', () => {
  const readRun: ContractInspector = (host) => {
    const run = host.querySelector<HTMLElement>('.gg-md')
    const style = run ? getComputedStyle(run) : null
    return { fontSize: style ? px(style.fontSize) : 0, lineHeight: style ? px(style.lineHeight) : 0 }
  }

  it.each([
    { label: 'default size', size: DEFAULT_CONFIG.roles.body.size },
    { label: 'enlarged size', size: DEFAULT_CONFIG.roles.body.size + 4 }
  ])('$label: reserves what it renders, at the compact rhythm', async ({ label, size }) => {
    const theme = buildChatTheme({
      ...DEFAULT_CONFIG,
      roles: { ...DEFAULT_CONFIG.roles, body: { ...DEFAULT_CONFIG.roles.body, size } }
    })
    for (const fixture of [htmlBody, htmlTableOverflowing]) {
      const reading = await read(fixture, WIDE, readRun, theme)
      expectHeightMatch(`${fixture.label} (${label})`, reading)
      expect(
        reading.inspected.fontSize,
        `${fixture.label} (${label}): run font-size resolved to ${reading.inspected.fontSize}px, so this case cannot fail on the value it is about`
      ).toBe(size)
      expect(
        reading.inspected.lineHeight,
        `${fixture.label} (${label}): run line-height ${reading.inspected.lineHeight}px is not .gg-md--compact's`
      ).toBe(compactLineHeight(size))
    }
  })
})

/**
 * #7333 Codex master: the body is 16/24 in the system face. A mixed CJK / Latin run carrying every inline role —
 * bold, italic, a link, inline code, a resolved @mention chip and a /command chip — must reserve exactly what it
 * paints at three widths. Chips have their own padding and font size, so sharing the 24px line is not taken on
 * faith: the height parity is read off the DOM, and so are the resolved face, size and line height (a declaration
 * that never reaches the run would otherwise pass).
 */
describe('mixed-script inline roles at the 16/24 body (#7333)', () => {
  const mixed = run(
    'text mixed cjk',
    'md-mixed-cjk',
    '中文正文和 English 混排:**加粗 bold** 与 *斜体 italic*,一个[链接 link](https://example.test),' +
      '行内代码 `inlineCode()`,提及 @file.ts 和命令 /deploy,宽度变化时它们一起换行,量出来的高度要和画出来的一致。'
  )
  const readMixed: ContractInspector = (host) => {
    const runEl = host.querySelector<HTMLElement>('.gg-md')
    const style = runEl ? getComputedStyle(runEl) : null
    return {
      fontSize: style ? px(style.fontSize) : 0,
      lineHeight: style ? px(style.lineHeight) : 0,
      systemFace: style && style.fontFamily.startsWith('-apple-system') ? 1 : 0,
      bold: host.querySelectorAll('.gg-md strong').length,
      italic: host.querySelectorAll('.gg-md em').length,
      links: host.querySelectorAll('.gg-md a').length,
      codes: host.querySelectorAll('.gg-md :not(pre) > code').length,
      mentions: host.querySelectorAll('.gg-md .gg-md-mention').length,
      commandChips: host.querySelectorAll('.gg-md .gg-md-mention[data-mention-tone="command"]').length,
      // The chips' own type: each must resolve to 14px, and no chip box may stand taller than the 24px line.
      chipSizeMismatches: [...host.querySelectorAll<HTMLElement>('.gg-md :not(pre) > code, .gg-md .gg-md-mention')]
        .filter((chip) => px(getComputedStyle(chip).fontSize) !== 14).length,
      tallestChip: Math.max(0, ...[...host.querySelectorAll<HTMLElement>('.gg-md :not(pre) > code, .gg-md .gg-md-mention')]
        .map((chip) => chip.getBoundingClientRect().height)),
    }
  }

  it.each([NARROW, 240, WIDE])('at %ipx it reserves what it renders, in the system face at 16/24', async (width) => {
    const reading = await read(mixed, width, readMixed)
    expectHeightMatch(`mixed cjk @ ${width}px`, reading)
    expect(reading.inspected.fontSize, 'the run did not resolve to the 16px body').toBe(16)
    expect(reading.inspected.lineHeight, 'the run did not resolve to the 24px body line').toBe(24)
    expect(reading.inspected.systemFace, 'the run is not drawn in the system face').toBe(1)
    // Every inline role is really present — otherwise the parity above is about a plainer run than the one named.
    expect(reading.inspected.bold).toBe(1)
    expect(reading.inspected.italic).toBe(1)
    expect(reading.inspected.links).toBe(1)
    expect(reading.inspected.codes).toBe(1)
    expect(reading.inspected.mentions, 'the @file and /command chips did not render').toBeGreaterThanOrEqual(2)
    expect(reading.inspected.commandChips, 'the /command chip did not render as its own tone').toBe(1)
    expect(reading.inspected.chipSizeMismatches, 'an inline chip did not resolve to 14px').toBe(0)
    expect(reading.inspected.tallestChip, 'a chip box stands taller than the 24px body line').toBeLessThanOrEqual(24)
  })

  /** Headings on the ladder (24/32 · 20/28 · 16/24 semibold), read off the painted run and held to measure parity. */
  it.each([
    { level: 1, size: 24, lineHeight: 32 },
    { level: 2, size: 20, lineHeight: 28 },
    { level: 3, size: 16, lineHeight: 24 },
  ])('h$level resolves to $size/$lineHeight and reserves what it renders', async ({ level, size, lineHeight }) => {
    const fixture = run(`text h${level} ladder`, `md-h${level}-ladder`, `${'#'.repeat(level)} 标题 Heading level ${level}`)
    const reading = await read(fixture, WIDE, (host) => {
      const heading = host.querySelector<HTMLElement>(`.gg-md h${level}`)
      const style = heading ? getComputedStyle(heading) : null
      return {
        found: heading ? 1 : 0,
        fontSize: style ? px(style.fontSize) : 0,
        lineHeight: style ? px(style.lineHeight) : 0,
        weight: style ? Number(style.fontWeight) : 0,
      }
    })
    expectHeightMatch(`h${level} ladder`, reading)
    expect(reading.inspected.found).toBe(1)
    expect(reading.inspected.fontSize).toBe(size)
    expect(Math.round(reading.inspected.lineHeight)).toBe(lineHeight)
    expect(reading.inspected.weight).toBe(600)
  })

  /** The code block is the mono face's own tier: 13/20, read off the painted lines (#7333). */
  it('a code block resolves to the 13/20 mono tier and reserves what it renders', async () => {
    const reading = await read(codePlain, WIDE, (host) => {
      // A transcript code block paints one absolutely placed div per line (codeLine); read the first painted line.
      const code = host.querySelector<HTMLElement>(`.${codeLine}`)
      const style = code ? getComputedStyle(code) : null
      return {
        found: code ? 1 : 0,
        fontSize: style ? px(style.fontSize) : 0,
        lineHeight: style ? px(style.lineHeight) : 0,
        mono: style && /JetBrains Mono/.test(style.fontFamily) ? 1 : 0,
      }
    })
    expectHeightMatch('code block 13/20', reading)
    expect(reading.inspected.found).toBe(1)
    expect(reading.inspected.fontSize).toBe(13)
    expect(reading.inspected.lineHeight).toBe(20)
    expect(reading.inspected.mono).toBe(1)
  })

  /** A table is the compact UI tier, 14/20 (#7333). The run's cells carry no class of their own: they only inherit the table. */
  it('a table resolves to 14/20 in every cell and reserves what it renders', async () => {
    const reading = await read(htmlTableFits, WIDE, (host) => {
      const cells = [...host.querySelectorAll<HTMLElement>('.gg-md th, .gg-md td')]
      return {
        cells: cells.length,
        offTier: cells.filter((cell) => {
          const style = getComputedStyle(cell)
          return px(style.fontSize) !== 14 || Math.round(px(style.lineHeight)) !== 20
        }).length,
      }
    })
    expectHeightMatch('table 14/20', reading)
    expect(reading.inspected.cells, 'the table rendered no cells').toBe(4)
    expect(reading.inspected.offTier, 'a table cell is not 14/20').toBe(0)
  })
})

/**
 * A text run is sanitized HTML, so `| :---: |` reaches the page only as the cell's `align`. The shared
 * table rule's `text-align: left` used to override it: every column of every transcript table read left.
 */
describe('table column alignment', () => {
  const ALIGN: Record<string, number> = { left: 0, center: 1, right: 2 }
  const htmlTableAligned = run('table aligned', 'md-table-aligned', '| L | C | R |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |')

  it('a column set to center or right is drawn that way, header and body alike', async () => {
    const reading = await read(htmlTableAligned, WIDE, (host) =>
      Object.fromEntries(
        [...host.querySelectorAll<HTMLTableCellElement>('th, td')].map((cell, index) => [
          `cell${index}`,
          ALIGN[getComputedStyle(cell).textAlign] ?? -1
        ])
      )
    )
    const cells = Object.fromEntries(Object.entries(reading.inspected).filter(([key]) => key.startsWith('cell')))
    expect(cells).toEqual({ cell0: 0, cell1: 1, cell2: 2, cell3: 0, cell4: 1, cell5: 2 })
  })
})

/**
 * Code inside a list or quote is coloured in place by `paintHighlight` (App pages colour all their code that way): one
 * span per token, the line breaks between them. A rule meant for Streamdown's line spans (`pre > code > span` as
 * blocks) used to catch these too, and every token stood on a line of its own.
 */
describe('code coloured by paintHighlight', () => {
  it('keeps its tokens inline: two source lines paint as two lines', () => {
    const root = document.createElement('div')
    root.className = 'gg-md gg-md--compact gg-md--transcript'
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    code.className = 'language-ts'
    pre.append(code)
    root.append(pre)
    document.body.append(root)
    const keyword = { '--shiki-light': '#d73a49', '--shiki-dark': '#f97583' }
    paintHighlight(code, {
      rootStyle: '',
      lines: [
        [{ content: 'const', htmlStyle: keyword }, { content: ' a = 1' }],
        [{ content: 'const', htmlStyle: keyword }, { content: ' b = 2' }]
      ]
    })
    try {
      expect([...code.querySelectorAll('span')].map((span) => getComputedStyle(span).display)).toEqual(['inline', 'inline', 'inline', 'inline'])
      expect(Math.round(code.getBoundingClientRect().height / px(getComputedStyle(code).lineHeight))).toBe(2)
    } finally {
      root.remove()
    }
  })
})
