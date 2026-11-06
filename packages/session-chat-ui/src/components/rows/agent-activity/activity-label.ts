import type { MeasureCtx } from '@session-chat/core/define';
import type { ChatTranslator } from '@session-chat/localization';
import type { ActivityActor, AgentActivityGroup } from '@session-chat/state/agent-activity';
import { activitySummary } from '@session-chat/state/activity-summary';
import { readableLabel } from '../readable-label';
import { ACTIVITY_LABEL_INSET } from './activity-metrics';

export type ActivityLabelPart = string | { actor: ActivityActor; label: string };

/** Fit names inside the sentence, so clipping a long name never removes its message count. */
export function activityLabel(group: AgentActivityGroup, t: ChatTranslator, ctx: MeasureCtx): ActivityLabelPart[] {
  // Icon, chevron, two gaps and horizontal padding use the row's existing geometry.
  const budget = Math.max(0, ctx.width - ACTIVITY_LABEL_INSET);
  const width = (text: string) => readableLabel(text, ctx, Number.MAX_SAFE_INTEGER, 12, 18, 400).width;
  const shorten = (text: string, limit: number) => {
    if (width(text) <= limit) return text;
    const chars = Array.from(text);
    let lo = 0, hi = chars.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (width(chars.slice(0, mid).join('') + '…') <= limit) lo = mid;
      else hi = mid - 1;
    }
    return chars.slice(0, lo).join('') + '…';
  };
  for (let limit = ctx.width < 480 ? 1 : 2; limit >= 0; limit--) {
    const parts = activitySummary(group, t, limit);
    const actors = parts.filter((part): part is ActivityActor => typeof part !== 'string');
    const fixed = parts.reduce((sum, part) => sum + (typeof part === 'string' ? width(part) : 0), 0);
    const available = budget - fixed;
    if (actors.length && available < actors.length * width('名字…')) continue;
    const sizes = actors.map(actor => width(actor.name));
    // Short names keep their natural width; long names share the remaining space.
    if (sizes.reduce((sum, size) => sum + size, 0) <= available)
      return parts.map(part => typeof part === 'string' ? part : { actor: part, label: part.name });
    let lo = 0, hi = Math.max(0, available);
    for (let step = 0; step < 16; step++) {
      const mid = (lo + hi) / 2;
      if (sizes.reduce((sum, size) => sum + Math.min(size, mid), 0) <= available) lo = mid;
      else hi = mid;
    }
    return parts.map(part => typeof part === 'string' ? part : { actor: part, label: shorten(part.name, lo) });
  }
  return activitySummary(group, t, 0).map(part => typeof part === 'string' ? part : { actor: part, label: part.name });
}
