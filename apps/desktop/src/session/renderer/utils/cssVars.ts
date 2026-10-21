// When embedded (gugu's 会话页 hosts the session page's React app inside a Shadow DOM
// subtree — see apps/desktop/src/components/sessionpage/EmdashSessionFrame.tsx),
// the session page's own theme classes (.emlight/.emdark, which define --xterm-bg etc.)
// live on the shadow-tree mount element, not on the real top-level
// document.documentElement. Reading computed style off documentElement in that
// case silently resolves every custom property to '' (correct-looking in
// a standalone session page, where the theme classes DO sit on documentElement, but
// invisible black-on-black text/UI once embedded — the property host exposes
// this mount element globally for exactly this kind of cross-cutting lookup).
function themeStyleRoot(): Element {
  const embedded = (window as unknown as { __EMDASH_MOUNT__?: Element }).__EMDASH_MOUNT__;
  return embedded ?? document.documentElement;
}

export function cssVar(name: string): string {
  return getComputedStyle(themeStyleRoot()).getPropertyValue(name).trim();
}

/**
 * Converts any CSS color string (hex, hsl, color(display-p3 ...), color-mix, etc.)
 * to a hex string by painting a 1×1 canvas pixel and reading back the sRGB bytes.
 * Out-of-gamut P3 values are clamped to sRGB, which is imperceptible for UI chrome colors.
 * Returns the original string unchanged if the canvas context is unavailable.
 */
export function cssColorToHex(cssColor: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) return cssColor;
  ctx.fillStyle = cssColor.trim();
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return a < 255 ? `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}` : `#${hex(r)}${hex(g)}${hex(b)}`;
}
