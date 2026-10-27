/** @jsxImportSource solid-js */
import { Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { useChatTranslator } from '@session-chat/localization';
import { formatElapsed } from '@session-chat/lib/format-elapsed';
import type { ChatMessage } from '@session-chat/model';
import { GridLoader } from '@session-chat/components/primitives/GridLoader';
import { ShimmerText } from '@session-chat/components/primitives/ShimmerText';
import { conversationProcessButton, conversationProcessChevron } from './conversation-message.css';

/** Completed thinking and execution, using the existing ChatRoot disclosure delegation. */
export function ConversationProcess(props: {
  process: NonNullable<ChatMessage['conversationProcess']>;
  anchorId: string;
  expanded: boolean;
  collapsible?: boolean;
}) {
  const translate = useChatTranslator();
  const [now, setNow] = createSignal(Date.now());
  const ticking = createMemo(() => !!props.process.live && props.process.startedAt !== undefined);
  createEffect(() => {
    if (!ticking()) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const elapsed = () => {
    const { startedAt, endedAt } = props.process;
    const end = props.process.live ? now() : endedAt;
    return startedAt !== undefined && end !== undefined && Number.isFinite(startedAt) && Number.isFinite(end)
      ? formatElapsed(Math.max(0, end - startedAt)) : null;
  };
  const label = () => `${translate('transcript.thinkingAndExecution')}${elapsed() ? ` · ${elapsed()}` : ''}`;
  // 在跑:点阵代替大脑,字写「思考执行中 · 1m15s」并带微光(owner 2026-10-27 原型);跑完换回大脑 + 用时。
  const liveLabel = () => `${translate('transcript.thinkingLive')}${elapsed() ? ` · ${elapsed()}` : ''}`;
  return <button type="button" class={conversationProcessButton} data-conversation-process={props.process.id}
    data-collapse-id={props.collapsible === false ? undefined : props.process.id} data-collapse-anchor={props.anchorId}
    aria-expanded={props.collapsible === false ? undefined : props.expanded} aria-label={label()} title={label()}>
    <Show when={!props.process.live} fallback={<><GridLoader /><ShimmerText active>{liveLabel()}</ShimmerText></>}>
      <svg width="17" height="17" viewBox="0 0 24 22" fill="none" stroke="currentColor" stroke-width="1.4"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M11.5 4.5C10 2 6 2 5 5c-3-.2-4 3-2.5 5-2 2 .1 5 2.5 4.5-.2 3 4.5 4.5 6.5 2M11.5 4.5C13 2 17 2 18 5c3-.2 4 3 2.5 5 2 2-.1 5-2.5 4.5.2 3-4.5 4.5-6.5 2V4.5Z" />
        <path d="m6 7 2 2-1 3m9-5-2 2 1 3M8 9h7" /><circle cx="7" cy="13" r=".6" /><circle cx="16" cy="13" r=".6" />
      </svg>
      <Show when={elapsed()}>{value => <span>{value()}</span>}</Show>
    </Show>
    <Show when={props.collapsible !== false}><span class={conversationProcessChevron} aria-hidden="true">›</span></Show>
  </button>;
}
