/**
 * The one ```svg fence renderer every surface draws with (chat bubbles, the transcript): an agent's figure becomes an
 * `<img>` of a `data:` SVG. An SVG loaded as an image runs no script and fetches nothing — the browser's own isolation,
 * so no sanitizer is needed. The agent colours with theme tokens (`var(--fg)`, `var(--c1)` …); they are written in as
 * this theme's colours before the image is made, since an image cannot see the page's CSS.
 */

/** Source bytes past this stay a code block. */
export const SVG_FIGURE_MAX_BYTES = 64 * 1024;

export type SvgFigure =
  | { ok: true; src: string; width: number; height: number }
  | { ok: false; reason: 'too-large' | 'invalid' | 'no-viewbox' };

/** Agent-facing token → the host variable it reads (series `c1`…`c6` → `--chart-1`…`--chart-6`). */
const HOST_TOKENS: Record<string, string> = {
  fg: '--text-primary',
  muted: '--text-secondary',
  border: '--border',
  surface: '--bg-secondary',
  accent: '--accent',
  success: '--green',
  warning: '--warn',
  error: '--danger',
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`c${n}`, `--chart-${n}`])),
};

/** Token → colour as the element the figure is drawn in resolves it now (light or dark). */
export function svgPalette(element: Element): Record<string, string> {
  const style = getComputedStyle(element);
  const palette: Record<string, string> = {};
  for (const [token, host] of Object.entries(HOST_TOKENS)) {
    const value = style.getPropertyValue(host).trim();
    if (value) palette[token] = value;
  }
  return palette;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const TOKEN = /var\(\s*--([a-z0-9-]+)\s*(?:,[^()]*)?\)/gi;

export function svgFigure(source: string, palette: Record<string, string>): SvgFigure {
  if (new TextEncoder().encode(source).length > SVG_FIGURE_MAX_BYTES) return { ok: false, reason: 'too-large' };
  const themed = source
    .replace(TOKEN, (token, name: string) => palette[name.toLowerCase()] ?? token)
    // Agents often leave out the namespace an image document needs; without it the root is not an SVG element.
    .replace(/<svg\b(?![^>]*\sxmlns=)/, `<svg xmlns="${SVG_NS}"`);
  const doc = new DOMParser().parseFromString(themed, 'image/svg+xml');
  const root = doc.documentElement;
  if (doc.getElementsByTagName('parsererror').length || root.namespaceURI !== SVG_NS || root.localName !== 'svg') return { ok: false, reason: 'invalid' };
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const [width, height] = [box[2], box[3]];
  if (box.length !== 4 || box.some((n) => !Number.isFinite(n)) || !(width! > 0) || !(height! > 0)) {
    return { ok: false, reason: 'no-viewbox' };
  }
  // The image's natural size is its viewBox (1 unit = 1px); the surface scales it down to fit.
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  if (!root.hasAttribute('color') && palette.fg) root.setAttribute('color', palette.fg);
  if (!root.hasAttribute('font-family')) root.setAttribute('font-family', 'sans-serif');
  const markup = new XMLSerializer().serializeToString(root);
  return { ok: true, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`, width: width!, height: height! };
}
