/** @jsxImportSource solid-js */
import { Show } from 'solid-js';
import { defineUnit } from '@session-chat/core/units';
import type { MeasureCtx } from '@session-chat/core/define';
import type { ChatMessage, ToolNode } from '@session-chat/model';
import type { ChatTranslator } from '@session-chat/localization';
import { IconCheck, IconX } from '@session-chat/components/primitives/icons';
import * as styles from './conversation-step.css';
import { tallyToolRun, toolRunLabel } from '@session-chat/state/tool-run';
import { toolStepDetail as stepDetail } from '@session-chat/lib/tool-step-detail';
import { ConversationTextBody, conversationNarrationHeight, conversationTextKey } from '../message/ConversationNarration';
import { conversationTextOverflow, conversationTextWidth } from '../message/conversation-text-overflow';
import { CollapseHeader } from '@session-chat/components/primitives/CollapseHeader';

type Step = Exclude<ToolNode, { kind: 'tool-group' }>;
type ConversationStepData = Step & { actionLabel: string; stateLabel: string | null };
const completion = (item: Step) => item.kind === 'subagent-done-tool-call' || item.kind === 'background-command-done-tool-call';
function stepText(item: Step): ChatMessage {
  const text = completion(item) ? [...new Set([item.title, 'summary' in item ? item.summary : undefined].filter(Boolean))].join('\n\n') : stepDetail(item) ?? '';
  return { kind: 'message', id: item.id, role: 'assistant', text };
}
function stateLabel(item: Step, translate: ChatTranslator): string | null {
  if (item.kind === 'spawn-subagent-tool-call') {
    if (item.agentStatus === 'completed') return translate('transcript.completed');
    if (item.agentStatus === 'failed' || item.agentStatus === 'lost') return translate('transcript.failed');
    if (item.agentStatus === 'stopped') return translate('transcript.processStepStopped');
    if (item.status === 'done') return translate('transcript.processStepBackground');
  }
  if (item.kind === 'execute-tool-call' && item.backgroundTaskId) return translate(item.backgroundTaskDone ? 'transcript.completed' : 'transcript.processStepBackground');
  return null;
}
/** Localized labels are shared by measurement and rendering. */
export function conversationStepData(item: Step, translate: ChatTranslator): ConversationStepData {
  const prefix = item.kind === 'background-command-done-tool-call' ? 'command' : 'subagent';
  const outcome = completion(item) && 'outcome' in item ? item.outcome : undefined;
  const actionLabel = completion(item) ? translate(`transcript.${prefix}${outcome === 'stopped' ? 'Stopped' : outcome !== 'completed' ? 'Failed' : 'Done'}`)
    : toolRunLabel(tallyToolRun([item], true), translate);
  return { ...item, actionLabel, stateLabel: stateLabel(item, translate) };
}
function canExpand(item: ConversationStepData, ctx: MeasureCtx): boolean {
  if (completion(item)) return !!stepText(item).text.trim();
  const text = stepDetail(item);
  if (!text?.trim()) return false;
  const width = ctx.width - 38 - conversationTextWidth(item.actionLabel, ctx)
    - (item.stateLabel ? 8 + conversationTextWidth(item.stateLabel, ctx, 12) : 0);
  return conversationTextOverflow(text, ctx, width, 12);
}

/** Prototype toolRow(): an action stays whole; only clipped details have a disclosure. */
export const conversationStepUnitDef = defineUnit<ConversationStepData, Record<string, never>>({
  kind: 'conversation-step', margin: { top: 0, bottom: 0 }, vars: {},
  measure: (item, ctx) => conversationNarrationHeight(stepText(item), ctx, canExpand(item, ctx)),
  Render(props) {
    const notice = () => completion(props.data);
    const failed = () => props.data.status === 'error' || ('outcome' in props.data && props.data.outcome !== 'completed');
    const detail = () => stepDetail(props.data);
    const text = () => stepText(props.data);
    const expandable = () => !!props.ctx.measureCtx && canExpand(props.data, props.ctx.measureCtx());
    const expanded = () => props.ctx.viewState.isCollapsed(conversationTextKey(props.data.id));
    return <div class={styles.row} data-conversation-step={props.data.id}>
      <Show when={notice()} fallback={
      <button type="button" class={styles.step} data-collapse-id={expandable() ? conversationTextKey(props.data.id) : undefined}
        data-collapse-anchor={props.data.id} aria-expanded={expandable() ? expanded() : undefined} disabled={!expandable()}>
      <span class={styles.slot} aria-hidden="true"><Show when={notice() || failed()}><Show when={!failed()} fallback={<IconX />}><IconCheck /></Show></Show></span>
        <span class={styles.name}>{props.data.actionLabel}</span><Show when={detail()}>{value => <code class={styles.detail} title={value()}>{value()}</code>}</Show>
        <Show when={props.data.stateLabel}>{value => <span class={styles.status}>{value()}</span>}</Show>
      </button>
      }>
        <CollapseHeader id={conversationTextKey(props.data.id)} anchorId={props.data.id} height={32} wrap labelSize={12} labelLineHeight={18}
          collapsible={expandable()} expanded={expanded()}>{props.data.actionLabel}</CollapseHeader>
      </Show>
      <ConversationTextBody data={text()} ctx={props.ctx} canExpand={expandable()} />
    </div>;
  },
});
