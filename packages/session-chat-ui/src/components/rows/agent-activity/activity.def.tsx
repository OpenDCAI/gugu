/** @jsxImportSource solid-js */
import { For } from 'solid-js';
import { defineUnit } from '@session-chat/core/units';
import { ShimmerText } from '@session-chat/components/primitives/ShimmerText';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { useChatTranslator } from '@session-chat/localization';
import type { AgentActivityGroup } from '@session-chat/state/agent-activity';
import { activitySummary, activitySummaryText } from '@session-chat/state/activity-summary';
import * as styles from './activity.css';
import { activityLabel } from './activity-label';
import { ACTIVITY_METRICS } from './activity-metrics';

export const activityUnitDef = defineUnit<AgentActivityGroup>({
  kind: 'agent-activity', margin: { top: 8, bottom: 8 }, estimate: () => ACTIVITY_METRICS.height, measure: () => ACTIVITY_METRICS.height,
  Render(props) {
    const commands = useCommands(), t = useChatTranslator();
    const parts = () => activitySummary(props.data, t, (props.ctx.measureCtx?.().width ?? 800) < 480 ? 1 : 2);
    const label = () => props.ctx.measureCtx ? activityLabel(props.data, t, props.ctx.measureCtx())
      : parts().map(part => typeof part === 'string' ? part : { actor: part, label: part.name });
    const expanded = () => props.ctx.viewState.isCollapsed(props.data.id);
    const live = () => props.data.events.some(event => event.live);
    return <div class={styles.row} data-agent-activity={props.data.id} data-live={live()} data-expanded={expanded()}
      data-activity-read-ids={!expanded() ? JSON.stringify(props.data.messageIds ?? []) : undefined}>
      <button type="button" class={styles.toggle} data-collapse-id={props.data.id} aria-expanded={expanded()}
        aria-label={t(expanded() ? 'transcript.activityCollapse' : 'transcript.activityExpand', { summary: activitySummaryText(parts()) })} />
      <span class={styles.inline}>
        <svg class={styles.icon} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9.5 17-5-5 5-5m-5 5h10c1.667 0 5 1 5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <ShimmerText active={live()} class={styles.label} title={activitySummaryText(parts())}>
          <For each={label()}>{part => typeof part === 'string' ? <span class={styles.word}>{part}</span> : <button type="button" class={styles.name}
            aria-label={part.actor.name} title={part.actor.name} data-activity-target={part.actor.id}
            onClick={event => { event.stopPropagation(); commands().onOpenSender?.(part.actor.target); }}>{part.label}</button>}</For>
        </ShimmerText>
        <svg class={styles.chevron} style={{ transform: expanded() ? 'rotate(90deg)' : undefined }} viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2.5 3.5 3.5L4 9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </span>
    </div>;
  },
});
