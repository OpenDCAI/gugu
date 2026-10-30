import { measureNaturalWidth, prepareWithSegments } from '@chenglou/pretext';
import { buildChatTheme } from '@session-chat/core/config';
import type { MeasureCtx } from '@session-chat/core/define';
import { applySoftWraps, measureSoftWrap } from '@session-chat/core/measure/soft-wrap';
import { defaultChatTranslator } from '@session-chat/localization';

export const rowTranslator = (ctx: MeasureCtx) => ctx.translate ?? defaultChatTranslator;

/** Break once, off screen, and paint those exact breaks. Native titles are not disclosures. */
export function readableLabel(text: string, ctx: MeasureCtx, width = ctx.width, size = 12, lineHeight = 18, weight = ctx.theme.config.roles.body.weight, tabular = false) {
  const config = ctx.theme.config;
  const font = buildChatTheme({ ...config, roles: { ...config.roles, body: { ...config.roles.body, size, lineHeight, weight } } }, ctx.theme.layout).fonts.body.font;
  const shaped = tabular ? text.replace(/\d/g, '0') : text;
  const wrap = measureSoftWrap(shaped, Math.max(1, width), font);
  return { text: applySoftWraps(text, wrap.softWrapOffsets), height: wrap.visualLineCount * lineHeight,
    width: measureNaturalWidth(prepareWithSegments(shaped, font, { whiteSpace: 'pre-wrap' })), size, lineHeight };
}

/** The same flex-wrap packing used by multi-part metadata rows (no DOM measurement). */
export function wrappedRowHeight(parts: readonly { width: number; height: number }[], width: number, gap: number, rowGap = 0) {
  let x = 0, line = 0, height = 0;
  for (const part of parts) {
    if (x && x + gap + part.width > width + .01) { height += line + rowGap; x = 0; line = 0; }
    x += (x ? gap : 0) + part.width;
    line = Math.max(line, part.height);
  }
  return height + line;
}
