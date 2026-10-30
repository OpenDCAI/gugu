/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { GridLoader } from '@session-chat/components/primitives/GridLoader';
import { IconCheck } from '@session-chat/components/primitives/icons';
import type { SubagentCall } from '@session-chat/lib/subagent-roster';
import { useChatTranslator } from '@session-chat/localization';
import { toolRunLabel } from '@session-chat/state/tool-run';
import * as styles from './background-tasks.css';

/** Stable call IDs keep a reader's disclosure open while progress snapshots arrive. */
export function SubagentProgress(props: { calls: readonly SubagentCall[] }) {
  const byId = createMemo(() => new Map(props.calls.map(call => [call.toolCallId, call])));
  const ids = createMemo(() => [...byId().keys()]);
  return <div class={styles.subagentTimeline} data-slot="subagent-timeline">
    <For each={ids()}>{id => <SubagentStep call={byId().get(id)!} />}</For>
  </div>;
}

function SubagentStep(props: { call: SubagentCall }) {
  const translate = useChatTranslator();
  const label = () => toolRunLabel({ [props.call.category]: 1 }, translate);
  const [clipped, setClipped] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  let summary!: HTMLSpanElement;
  const check = () => setClipped(/\r|\n/.test(props.call.detail) || summary.scrollWidth > summary.clientWidth);
  onMount(() => {
    const observer = new ResizeObserver(check);
    observer.observe(summary);
    onCleanup(() => observer.disconnect());
    check();
  });
  createEffect(() => { void props.call.detail; void label(); queueMicrotask(check); });
  return <div class={styles.subagentTimelineStep} data-slot="subagent-timeline-step" data-status={props.call.status}>
    <button type="button" class={styles.subagentStepTrigger} disabled={!clipped()}
      aria-expanded={clipped() ? open() : undefined} onClick={() => setOpen(value => !value)}>
      <span class={styles.subagentTimelineMarker} data-status={props.call.status}>
        <Switch fallback={<GridLoader />}>
          <Match when={props.call.status === 'done'}><IconCheck /></Match>
          <Match when={props.call.status === 'error'}><span class={styles.subagentTimelineErrorDot} /></Match>
        </Switch>
      </span>
      <span class={styles.subagentStepAction} data-slot="subagent-step-action">{label()}</span>
      <span ref={summary} class={styles.subagentTimelineTitle} data-slot="subagent-step-summary">{props.call.detail.replace(/\r\n|\r|\n/g, ' ')}</span>
      <span class={styles.subagentStepChevron} aria-hidden="true">{clipped() ? (open() ? '⌄' : '›') : ''}</span>
    </button>
    <Show when={clipped() && open()}><div class={styles.subagentStepDetail} data-slot="subagent-step-detail">{props.call.detail}</div></Show>
  </div>;
}
