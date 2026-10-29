/** @jsxImportSource solid-js */
import { Show } from 'solid-js';
import { defineUnit } from '@session-chat/core/units';
import type { ChatMessage, ToolNode } from '@session-chat/model';
import { useChatTranslator } from '@session-chat/localization';
import { IconCheck, IconX } from '@session-chat/components/primitives/icons';
import * as styles from './conversation-step.css';
import { tallyToolRun, toolRunLabel } from '@session-chat/state/tool-run';
import { deriveToolInputSummary } from '../tools/tool-input-summary';
import { ConversationTextBody, conversationNarrationHeight, conversationTextKey } from '../message/ConversationNarration';

type Step = Exclude<ToolNode, { kind: 'tool-group' }>;
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
  const text = completion(item) ? ('summary' in item && item.summary ? item.summary : item.title)
    : stepDetail(item) ?? '';
  return { kind: 'message', id: item.id, role: 'assistant', text };
}

/** Prototype toolRow(): a plain step, including when disclosed from a multi-call run. */
export const conversationStepUnitDef = defineUnit<Exclude<ToolNode, { kind: 'tool-group' }>, Record<string, never>>({
  kind: 'conversation-step', margin: { top: 0, bottom: 0 }, vars: {},
  measure: (item, ctx) => conversationNarrationHeight(stepText(item), ctx),
  Render(props) {
    const translate = useChatTranslator();
    const notice = () => completion(props.data);
    const failed = () => props.data.status === 'error' || ('outcome' in props.data && props.data.outcome !== 'completed');
    const name = () => toolRunLabel(tallyToolRun([props.data], true), translate);
    const detail = () => stepDetail(props.data);
    const summary = () => 'summary' in props.data && props.data.summary ? props.data.summary : props.data.title;
    const state = () => {
      const item = props.data;
      if (item.kind === 'spawn-subagent-tool-call') {
        if (item.agentStatus === 'completed') return translate('transcript.completed');
        if (item.agentStatus === 'failed' || item.agentStatus === 'lost') return translate('transcript.failed');
        if (item.agentStatus === 'stopped') return translate('transcript.processStepStopped');
        if (item.status === 'done') return translate('transcript.processStepBackground');
      }
      if (item.kind === 'execute-tool-call' && item.backgroundTaskId) return translate(item.backgroundTaskDone ? 'transcript.completed' : 'transcript.processStepBackground');
      return null;
    };
    const text = () => stepText(props.data);
    const expanded = () => props.ctx.viewState.isCollapsed(conversationTextKey(props.data.id));
    return <div class={styles.row} data-conversation-step={props.data.id}>
      <button type="button" class={styles.step} data-collapse-id={conversationTextKey(props.data.id)}
        data-collapse-anchor={props.data.id} aria-expanded={text().text.trim() ? expanded() : undefined} disabled={!text().text.trim()}>
      <span class={styles.slot} aria-hidden="true"><Show when={notice() || failed()}><Show when={!failed()} fallback={<IconX />}><IconCheck /></Show></Show></span>
      <Show when={!notice()} fallback={<span class={styles.noticeSummary}>{summary()}</span>}>
        <span class={styles.name}>{name()}</span><Show when={detail()}>{value => <code class={styles.detail} title={value()}>{value()}</code>}</Show>
        <Show when={state()}>{value => <span class={styles.status}>{value()}</span>}</Show>
      </Show>
      </button>
      <ConversationTextBody data={text()} ctx={props.ctx} />
    </div>;
  },
});
