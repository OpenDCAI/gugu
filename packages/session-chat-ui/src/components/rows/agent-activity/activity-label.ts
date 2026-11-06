import type { MeasureCtx } from '@session-chat/core/define';
import type { ChatTranslator } from '@session-chat/localization';
import type { ActivityActor, AgentActivityGroup } from '@session-chat/state/agent-activity';
import { activitySummary } from '@session-chat/state/activity-summary';
import { readableLabel } from '../readable-label';
import { ACTIVITY_LABEL_INSET, ACTIVITY_METRICS as metrics } from './activity-metrics';

export type ActivityLabelPart = string | { actor: ActivityActor; label: string };
const textOf = (part: ActivityLabelPart) => typeof part === 'string' ? part : part.label;

/** Break the whole sentence once; preserve clickable actor fragments across those exact lines. */
export function activityLabel(group: AgentActivityGroup, t: ChatTranslator, ctx: MeasureCtx) {
  const budget = Math.max(1, ctx.width - ACTIVITY_LABEL_INSET);
  const shape = (text: string, width = budget) => readableLabel(text, ctx, width, 12, metrics.lineHeight, 400);
  let selected: ActivityLabelPart[] = [];
  for (let limit = 2; limit >= 0; limit--) {
    const parts = activitySummary(group, t, limit);
    const names = parts.filter((part): part is ActivityActor => typeof part !== 'string');
    const fit = (cap: number): ActivityLabelPart[] => parts.map(part => {
      if (typeof part === 'string') return part;
      const chars = Array.from(part.name);
      return { actor: part, label: chars.length <= cap ? part.name : chars.slice(0, cap).join('') + '…' };
    });
    const fits = (parts: ActivityLabelPart[]) => shape(parts.map(textOf).join('')).height <= metrics.maxLines * metrics.lineHeight;
    selected = fit(Number.MAX_SAFE_INTEGER);
    if (fits(selected)) break;
    // Only shorten names after natural wrapping uses all three lines. Fixed count words stay intact.
    if (!names.length || !fits(fit(2))) continue;
    let lo = 2, hi = Math.max(...names.map(name => Array.from(name.name).length));
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(fit(mid))) lo = mid; else hi = mid - 1;
    }
    selected = fit(lo);
    break;
  }
  const wrapped = shape(selected.map(textOf).join(''));
  const lines: ActivityLabelPart[][] = [];
  let offset = 0;
  for (const line of wrapped.text.split('\n')) {
    const end = offset + line.length;
    let start = 0;
    const fragments: ActivityLabelPart[] = [];
    for (const part of selected) {
      const text = textOf(part), stop = start + text.length;
      if (stop > offset && start < end) {
        const label = text.slice(Math.max(0, offset - start), Math.min(text.length, end - start));
        fragments.push(typeof part === 'string' ? label : { actor: part.actor, label });
      }
      start = stop;
    }
    // Pretext hangs spaces at a line break; do not turn them into flex-item width.
    const last = fragments.at(-1);
    if (typeof last === 'string') fragments[fragments.length - 1] = last.trimEnd();
    lines.push(fragments);
    offset = end;
  }
  return { lines, height: Math.max(metrics.height, wrapped.height + 2 * metrics.paddingY),
    width: Math.min(budget, Math.max(...lines.map(line => shape(line.map(textOf).join(''), Number.MAX_SAFE_INTEGER).width))) };
}
