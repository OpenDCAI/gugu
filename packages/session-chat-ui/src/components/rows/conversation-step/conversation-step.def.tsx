/** @jsxImportSource solid-js */
import { Show } from 'solid-js';
import { defineUnit } from '@session-chat/core/units';
import type { ToolNode } from '@session-chat/model';
import { useChatTranslator } from '@session-chat/localization';
import { IconCheck, IconX } from '@session-chat/components/primitives/icons';
import * as styles from './conversation-step.css';

/** Prototype toolRow(): a plain step, including when disclosed from a multi-call run. */
export const conversationStepUnitDef = defineUnit<Exclude<ToolNode, { kind: 'tool-group' }>, Record<string, never>>({
  kind: 'conversation-step', margin: { top: 0, bottom: 0 }, vars: {},
  measure: () => 32,
  Render(props) {
    const translate = useChatTranslator();
    const notice = () => props.data.kind === 'subagent-done-tool-call' || props.data.kind === 'background-command-done-tool-call';
    const failed = () => props.data.status === 'error' || ('outcome' in props.data && props.data.outcome !== 'completed');
    const name = () => props.data.toolName ?? (props.data.kind === 'mcp-tool-call' ? props.data.tool
      : props.data.kind === 'execute-tool-call' ? 'Bash' : props.data.kind === 'spawn-subagent-tool-call' ? 'Agent' : props.data.title);
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
    return <div class={styles.step} data-conversation-step={props.data.id}>
      <span class={styles.slot} aria-hidden="true"><Show when={notice() || failed()}><Show when={!failed()} fallback={<IconX />}><IconCheck /></Show></Show></span>
      <Show when={!notice()} fallback={<span>{summary()}</span>}>
        <span class={styles.name}>{name()}</span><code class={styles.detail} title={props.data.title}>{props.data.title}</code>
        <Show when={state()}>{value => <span class={styles.status}>{value()}</span>}</Show>
      </Show>
    </div>;
  },
});
