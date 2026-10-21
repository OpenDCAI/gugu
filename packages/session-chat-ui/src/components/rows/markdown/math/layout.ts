/**
 * layout.ts — typeset a LaTeX formula and report the box it occupies.
 *
 * ── Why this is a DOM measurement and not arithmetic ─────────────────────────
 *
 * A code block is measured by formula (`lines * lineHeight + padding`). None of
 * that is available for mathematics. The height of `\frac{\sqrt{\pi}}{2}` is decided by KaTeX's
 * own typesetting — how deep the radical nests, how far the fraction bar sits
 * from the baseline, which of the KaTeX_Size faces the delimiters grow into.
 * There is no shortcut that is also correct, and an estimate is worse than
 * useless here: the virtualizer positions rows from reserved heights, so a
 * height that is wrong by 8px is rows that overlap or a scroll that jumps.
 *
 * So the formula is really typeset, offscreen, and the resulting box is read.
 * The same HTML that was measured is the HTML that gets painted, under the same
 * classes, at the same font size — the render cannot disagree with the measure
 * because it is not an independent second attempt at the same question.
 *
 * ── Why a module-level cache ─────────────────────────────────────────────────
 *
 * This mirrors pretext, whose glyph metrics are likewise a global content-keyed
 * cache flushed by `clearTextMeasure()`. A typeset result is a pure function of
 * (source, font size, available width); nothing about it is
 * per-conversation. `clearMathMeasure()` is wired into the same font-load flush
 * as pretext's, because KaTeX metrics are wrong until the KaTeX faces load —
 * exactly the failure the pretext flush already exists to fix.
 *
 * Requires a DOM. So does pretext (it measures through a canvas context and
 * throws without one), so this adds no new environment requirement.
 */

import katex from 'katex';
import 'katex/dist/katex.min.css';
import { mathBlock, mathContent, mathError } from './math.css';

/** A typeset formula: the HTML that was measured, and the box it filled. */
export type MathMetrics = {
  /** KaTeX HTML, or an escaped-source fallback when the formula does not parse. */
  html: string;
  /** Natural typeset width in px (never wrapped — KaTeX does not line-break). */
  width: number;
  /** Typeset height in px, rounded up so a reserved band never under-reserves. */
  height: number;
  /** True when KaTeX rejected the source and `html` is the error fallback. */
  failed: boolean;
};

const MAX_CACHE_ENTRIES = 300;
const metricsCache = new Map<string, MathMetrics>();

let measureHost: HTMLElement | null = null;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * KaTeX HTML for `tex`, or a visible error fallback carrying the source.
 *
 * `throwOnError: false` is not a swallowed error: KaTeX renders the offending
 * source in its error colour, which is the same "show what is actually there"
 * the rest of this engine does. The outer catch covers the harder failures
 * (a malformed macro that throws before KaTeX can build its own fallback) and
 * still keeps the source on screen rather than dropping the content.
 */
function typeset(tex: string): { html: string; failed: boolean } {
  try {
    return {
      html: katex.renderToString(tex, {
        displayMode: true,
        throwOnError: false,
        output: 'html',
        strict: false,
      }),
      failed: false,
    };
  } catch {
    return { html: `<span class="${mathError}">${escapeHtml(tex)}</span>`, failed: true };
  }
}

/**
 * A detached-but-laid-out host on `document.body`.
 *
 * It must be in the layout tree — `visibility: hidden` rather than
 * `display: none` — because a display:none subtree has no boxes to read. It is
 * kept and reused rather than created per call so a transcript full of formulas
 * does not thrash the document, and re-created if something else removes it.
 */
function getMeasureHost(): HTMLElement {
  if (measureHost?.isConnected) return measureHost;
  const host = document.createElement('div');
  host.setAttribute('data-chat-math-measure', '');
  host.style.cssText =
    'position:absolute;top:0;left:-99999px;visibility:hidden;pointer-events:none;contain:layout style;';
  document.body.appendChild(host);
  measureHost = host;
  return host;
}

function measure(
  tex: string,
  fontSize: number,
  availableWidth: number
): MathMetrics {
  const { html, failed } = typeset(tex);

  const host = getMeasureHost();
  // The wrapper reproduces the painted context: the same class, the same font
  // size, and — for display math — the same available width, since that is what
  // decides whether the formula overflows and needs a scroll track.
  const wrapper = document.createElement('div');
  wrapper.className = mathBlock;
  wrapper.style.position = 'static';
  wrapper.style.inset = 'auto';
  wrapper.style.overflow = 'visible';
  wrapper.style.fontSize = `${fontSize}px`;
  wrapper.style.width = `${availableWidth}px`;

  const content = document.createElement('span');
  content.className = mathContent;
  content.innerHTML = html;
  wrapper.appendChild(content);
  host.appendChild(wrapper);

  const box = content.getBoundingClientRect();
  const metrics: MathMetrics = {
    html,
    width: box.width,
    // Rounded up, never down: the band this feeds must contain the glyphs, and
    // a sub-pixel shortfall is a clipped descender on every fraction.
    height: Math.ceil(box.height),
    failed,
  };

  host.removeChild(wrapper);
  return metrics;
}

function cacheKey(
  tex: string,
  fontSize: number,
  availableWidth: number
): string {
  return `${fontSize}\u0000${availableWidth}\u0000${tex}`;
}

function measureCached(
  tex: string,
  fontSize: number,
  availableWidth: number
): MathMetrics {
  const key = cacheKey(tex, fontSize, availableWidth);
  const hit = metricsCache.get(key);
  if (hit !== undefined) {
    metricsCache.delete(key);
    metricsCache.set(key, hit);
    return hit;
  }
  const metrics = measure(tex, fontSize, availableWidth);
  if (metricsCache.size >= MAX_CACHE_ENTRIES) {
    metricsCache.delete(metricsCache.keys().next().value!);
  }
  metricsCache.set(key, metrics);
  return metrics;
}

/** Typeset a display formula at `fontSize` inside `availableWidth` px. */
export function measureDisplayMath(
  tex: string,
  fontSize: number,
  availableWidth: number
): MathMetrics {
  return measureCached(tex, fontSize, availableWidth);
}

let scrollbarThickness: number | null = null;

/**
 * Height a horizontal scroll track steals from a scrolling box, in px.
 *
 * Zero on macOS overlay scrollbars, ~15px on the classic scrollbars Linux and
 * headless Chromium use. An over-wide formula scrolls, so the block has to
 * reserve this or the bottom of the formula is cut off on exactly the platforms
 * that draw a track — a defect invisible to anyone developing on a Mac.
 */
export function horizontalScrollbarThickness(): number {
  if (scrollbarThickness !== null) return scrollbarThickness;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;top:0;left:-99999px;width:100px;height:100px;overflow-x:scroll;overflow-y:hidden;visibility:hidden;';
  document.body.appendChild(probe);
  scrollbarThickness = probe.offsetHeight - probe.clientHeight;
  probe.remove();
  return scrollbarThickness;
}

/**
 * Drop every typeset measurement.
 *
 * Called from `ChatCaches.clearTextMeasure()`, i.e. once the real fonts have
 * loaded. Before that point KaTeX has been laying out against fallback faces
 * and every height in the cache is a measurement of the wrong typeface.
 */
export function clearMathMeasure(): void {
  metricsCache.clear();
  if (measureHost?.isConnected) measureHost.remove();
  measureHost = null;
}

