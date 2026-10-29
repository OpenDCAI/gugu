/** @jsxImportSource solid-js */
import { Show } from 'solid-js';
import { defineUnit } from '@session-chat/core/units';
import type { MeasureCtx } from '@session-chat/core/define';
import type { ChatMessage, ToolNode } from '@session-chat/model';
import type { ChatTranslator } from '@session-chat/localization';
import { IconCheck, IconX } from '@session-chat/components/primitives/icons';
import * as styles from './conversation-step.css';
import { tallyToolRun, toolRunLabel } from '@session-chat/state/tool-run';
import { deriveToolInputSummary } from '../tools/tool-input-summary';
import { ConversationTextBody, conversationNarrationHeight, conversationTextKey } from '../message/ConversationNarration';
import { conversationTextOverflow, conversationTextWidth } from '../message/conversation-text-overflow';

type Step = Exclude<ToolNode, { kind: 'tool-group' }>;
type ConversationStepData = Step & { actionLabel: string; stateLabel: string | null };
function stepDetail(item: Step): string | undefined {
  switch (item.kind) {
    case 'execute-tool-call': return item.command ?? item.inputSummary ?? deriveToolInputSummary(item.rawInput);
    case 'read-tool-call': return item.path ?? item.resource;
    case 'search-tool-call': return item.query;
    case 'web-fetch-tool-call': return item.url;
    case 'spawn-subagent-tool-call': return item.name;
    default: return item.inputSummary ?? deriveToolInputSummary(item.rawInput);
  }
}
const completion = (item: Step) => item.kind === 'subagent-done-tool-call' || item.kind === 'background-command-done-tool-call';
function stepText(item: Step): ChatMessage {
  const text = completion(item) ? ('summary' in item && item.summary ? item.summary : item.title) : stepDetail(item) ?? '';
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
  return { ...item, actionLabel: toolRunLabel(tallyToolRun([item], true), translate), stateLabel: stateLabel(item, translate) };
}
function canExpand(item: ConversationStepData, ctx: MeasureCtx): boolean {
  if (completion(item)) return conversationTextOverflow(stepText(item).text, ctx, ctx.width - 20);
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
    const summary = () => 'summary' in props.data && props.data.summary ? props.data.summary : props.data.title;
    const text = () => stepText(props.data);
    const expandable = () => !!props.ctx.measureCtx && canExpand(props.data, props.ctx.measureCtx());
    const expanded = () => props.ctx.viewState.isCollapsed(conversationTextKey(props.data.id));
    return <div class={styles.row} data-conversation-step={props.data.id}>
      <button type="button" class={styles.step} data-collapse-id={expandable() ? conversationTextKey(props.data.id) : undefined}
        data-collapse-anchor={props.data.id} aria-expanded={expandable() ? expanded() : undefined} disabled={!expandable()}>
      <span class={styles.slot} aria-hidden="true"><Show when={notice() || failed()}><Show when={!failed()} fallback={<IconX />}><IconCheck /></Show></Show></span>
      <Show when={!notice()} fallback={<span class={styles.noticeSummary}>{summary()}</span>}>
        <span class={styles.name}>{props.data.actionLabel}</span><Show when={detail()}>{value => <code class={styles.detail} title={value()}>{value()}</code>}</Show>
        <Show when={props.data.stateLabel}>{value => <span class={styles.status}>{value()}</span>}</Show>
      </Show>
      </button>
      <ConversationTextBody data={text()} ctx={props.ctx} canExpand={expandable()} />
    </div>;
  },
});
