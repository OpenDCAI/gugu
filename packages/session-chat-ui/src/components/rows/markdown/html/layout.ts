/**
 * layout.ts — lay an html block out offscreen and read its box.
 *
 * Same contract as display math: the markup that is measured here is the markup
 * that gets painted, under the same classes, font and width, so the reserved
 * height and the painted height are one measurement. The block's font comes from
 * the chat theme, the typography (line height included) from `.gg-md`.
 *
 * Two readings per block: the height at the row width, and the natural width
 * (widest line, capped at the row width) that the user pill hugs.
 *
 * Requires a DOM, like pretext and the math typesetter.
 */

import '@gugu/session-shared/markdown.css';
import 'katex/dist/katex.min.css';
import type { ResolvedTheme } from '@session-chat/core/config';
import type { HtmlBlock } from '@session-chat/core/markdown/document';

export type HtmlMetrics = { height: number; width: number };

const MAX_CACHE_ENTRIES = 2000;
const metricsCache = new Map<string, HtmlMetrics>();
const proseLineCache = new Map<string, number>();
let measureHost: HTMLElement | null = null;

export function htmlBlockClass(block: HtmlBlock): string {
  return block.flat ? 'gg-md gg-md--compact gg-md--transcript gg-md--flat' : 'gg-md gg-md--compact gg-md--transcript';
}

/**
 * The chat theme's body font and mono family, set inline so measure and paint cannot disagree: both are
 * measurement inputs, and the offscreen host sits outside the chat root that defines the theme's variables.
 * The shorthand also resets line-height to `normal`; dropping that leaves `.gg-md--compact`'s rhythm, the
 * same as every other compact markdown surface.
 */
export function applyBodyType(el: HTMLElement, theme: ResolvedTheme): void {
  el.style.font = theme.fonts.body.font;
  el.style.removeProperty('line-height');
  el.style.setProperty('--font-family-mono', theme.themeVars.fontMono);
}

/**
 * Laid out, not displayed: `visibility: hidden` keeps boxes to read (display:none has none). Kept and reused
 * so a long transcript does not thrash the document; re-created if something removed it.
 */
function getMeasureHost(): HTMLElement {
  if (measureHost?.isConnected) return measureHost;
  const host = document.createElement('div');
  host.setAttribute('data-chat-html-measure', '');
  host.style.cssText =
    'position:absolute;top:0;left:-99999px;visibility:hidden;pointer-events:none;contain:layout style;';
  document.body.appendChild(host);
  measureHost = host;
  return host;
}

function measure(block: HtmlBlock, width: number, theme: ResolvedTheme): HtmlMetrics {
  const el = document.createElement('div');
  el.className = htmlBlockClass(block);
  applyBodyType(el, theme);
  el.innerHTML = block.html;
  const host = getMeasureHost();
  host.appendChild(el);
  el.style.width = 'max-content';
  el.style.maxWidth = `${width}px`;
  const natural = el.getBoundingClientRect().width;
  el.style.maxWidth = '';
  el.style.width = `${width}px`;
  // Rounded up, never down: a band that under-reserves by a fraction clips the last line's descenders.
  const height = Math.ceil(el.getBoundingClientRect().height);
  host.removeChild(el);
  return { height, width: Math.min(width, Math.ceil(natural)) };
}

export function measureHtml(block: HtmlBlock, width: number, theme: ResolvedTheme): HtmlMetrics {
  const type = `${theme.fonts.body.font}\u0000${theme.themeVars.fontMono}`;
  const key = `${block.flat ? 'f' : 'b'}\u0000${width}\u0000${type}\u0000${block.html}`;
  const hit = metricsCache.get(key);
  if (hit !== undefined) {
    metricsCache.delete(key);
    metricsCache.set(key, hit);
    return hit;
  }
  const metrics = measure(block, width, theme);
  if (metricsCache.size >= MAX_CACHE_ENTRIES) metricsCache.delete(metricsCache.keys().next().value!);
  metricsCache.set(key, metrics);
  return metrics;
}

/**
 * `lines` lines of transcript prose, at the line height `.gg-md--compact` gives the theme's body font (read off the
 * stylesheet the way a block is laid out) and rounded up as `measure()` rounds. Estimates count lines with it, so a
 * row reserved before it is measured is reserved at the rhythm its lines will paint at, in whole pixels like a
 * measured row: a fractional reservation leaves a sub-pixel remainder in every scroll compensation.
 */
export function proseLinesHeight(lines: number, theme: ResolvedTheme): number {
  const font = theme.fonts.body.font;
  let lineHeight = proseLineCache.get(font);
  if (lineHeight === undefined) {
    const el = document.createElement('div');
    el.className = 'gg-md gg-md--compact gg-md--transcript';
    applyBodyType(el, theme);
    getMeasureHost().appendChild(el);
    lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
    el.remove();
    // Before the stylesheet applies, line-height reads `normal` (NaN): not kept, and the theme's line stands in.
    if (!Number.isFinite(lineHeight)) return Math.ceil(lines * theme.fonts.body.lineHeight);
    proseLineCache.set(font, lineHeight);
  }
  return Math.ceil(lines * lineHeight);
}

/** Called with the font-load flush: every cached box was laid out against the faces resolved at the time. */
export function clearHtmlMeasure(): void {
  metricsCache.clear();
  proseLineCache.clear();
  if (measureHost?.isConnected) measureHost.remove();
  measureHost = null;
}
