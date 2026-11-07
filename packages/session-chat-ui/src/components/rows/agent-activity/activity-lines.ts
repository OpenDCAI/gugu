import { measureNaturalWidth, prepareWithSegments } from '@chenglou/pretext';
import type { MeasureCtx } from '@session-chat/core/define';
import { buildChatTheme } from '@session-chat/core/config';
import type { ActivityActor } from '@session-chat/state/agent-activity';
import { readableLabel } from '../readable-label';
import { ACTIVITY_LABEL_INSET, ACTIVITY_METRICS as metrics } from './activity-metrics';

export type ActivityLabelPart = string | { actor: ActivityActor; label: string };
export type ActivityLabelLine = { parts: ActivityLabelPart[]; hanging: string };
const textOf = (part: ActivityLabelPart) => typeof part === 'string' ? part : part.label;

function projectLine(parts: ActivityLabelPart[], offset: number, end: number): ActivityLabelLine {
  let start = 0, hanging = '';
  const fragments: ActivityLabelPart[] = [];
  for (const part of parts) {
    const text = textOf(part), stop = start + text.length;
    if (stop > offset && start < end) {
      const label = text.slice(Math.max(0, offset - start), Math.min(text.length, end - start));
      fragments.push(typeof part === 'string' ? label : { actor: part.actor, label });
    }
    start = stop;
  }
  while (fragments.length) {
    const last = fragments.at(-1)!, text = textOf(last), visible = text.trimEnd();
    hanging = text.slice(visible.length) + hanging;
    if (visible) { fragments[fragments.length - 1] = typeof last === 'string' ? visible : { ...last, label: visible }; break; }
    fragments.pop();
  }
  return { parts: fragments, hanging };
}

/** Each painted span/button shapes independently, including contextual CJK punctuation. */
export function activityLines(parts: ActivityLabelPart[], ctx: MeasureCtx, stopAfter = Infinity) {
  const budget = Math.max(1, Math.floor(ctx.width - ACTIVITY_LABEL_INSET));
  const config = ctx.theme.config;
  const font = buildChatTheme({ ...config, roles: { ...config.roles, body: { ...config.roles.body, size: 12, lineHeight: metrics.lineHeight, weight: 400 } } }, ctx.theme.layout).fonts.body.font;
  const text = parts.map(textOf).join(''), lines: ActivityLabelLine[] = [];
  const fragmentWidth = (part: ActivityLabelPart) => {
    const advance = measureNaturalWidth(prepareWithSegments(textOf(part), font, { whiteSpace: 'pre-wrap' }));
    // Each flex item receives its own 1/64 CSS-pixel layout-unit rounding before summation.
    return Math.ceil(advance * 64) / 64;
  };
  let offset = 0, maxWidth = 0;
  while (offset < text.length && lines.length < stopAfter) {
    let available = budget, end: number, line: ActivityLabelLine, width: number;
    for (;;) {
      const first = readableLabel(text.slice(offset), ctx, available, 12, metrics.lineHeight, 400).text.split('\n')[0]!;
      end = offset + first.length;
      line = projectLine(parts, offset, end);
      // Keep both independent shaping and each fragment's layout-unit advance.
      width = Math.ceil(line.parts.reduce((sum, part) => sum + fragmentWidth(part), 0));
      if (width <= budget || available === 1) break;
      available = Math.max(1, available - (width - budget));
    }
    lines.push(line); maxWidth = Math.max(maxWidth, width);
    offset = end;
    if (text[offset] === '\n') { line.hanging += '\n'; offset++; }
  }
  return { lines, width: Math.min(budget, maxWidth), height: Math.max(metrics.height, lines.length * metrics.lineHeight + 2 * metrics.paddingY) };
}
