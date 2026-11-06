import type { MeasureCtx } from '@session-chat/core/define';
import type { ChatTranslator } from '@session-chat/localization';
import type { ActivityActor, AgentActivityGroup } from '@session-chat/state/agent-activity';
import { activitySummary } from '@session-chat/state/activity-summary';
import { ACTIVITY_METRICS as metrics } from './activity-metrics';
import { activityLines, type ActivityLabelPart } from './activity-lines';
export type { ActivityLabelPart } from './activity-lines';

/** Fit the same independently shaped fragments the actor controls paint. */
export function activityLabel(group: AgentActivityGroup, t: ChatTranslator, ctx: MeasureCtx) {
  let selected: ActivityLabelPart[] = [];
  for (let limit = 2; limit >= 0; limit--) {
    const parts = activitySummary(group, t, limit);
    const names = parts.filter((part): part is ActivityActor => typeof part !== 'string');
    const fit = (cap: number): ActivityLabelPart[] => parts.map(part => {
      if (typeof part === 'string') return part;
      const chars = Array.from(part.name);
      return { actor: part, label: chars.length <= cap ? part.name : chars.slice(0, cap).join('') + '…' };
    });
    const fits = (parts: ActivityLabelPart[]) => activityLines(parts, ctx, metrics.maxLines + 1).lines.length <= metrics.maxLines;
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
  return activityLines(selected, ctx);
}
