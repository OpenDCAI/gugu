/** @jsxImportSource solid-js */
import { Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { useChatTranslator } from '@session-chat/localization';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { formatElapsed } from '@session-chat/lib/format-elapsed';
import type { ChatMessage } from '@session-chat/model';
import { GridLoader } from '@session-chat/components/primitives/GridLoader';
import { ShimmerText } from '@session-chat/components/primitives/ShimmerText';
import type { MeasureCtx } from '@session-chat/core/define';
import { processButtonLayout } from './process-row-layout';
import { conversationProcessButton, conversationProcessChevron } from './conversation-message.css';

/** Completed thinking and execution, using the existing ChatRoot disclosure delegation. */
export function ConversationProcess(props: {
  process: NonNullable<ChatMessage['conversationProcess']>;
  anchorId: string;
  expanded: boolean;
  collapsible?: boolean;
  measureCtx: () => MeasureCtx;
}) {
  const translate = useChatTranslator();
  const commands = useCommands();
  const clock = () => commands().conversationClock?.() ?? Date.now();
  const [now, setNow] = createSignal(clock());
  const ticking = createMemo(() => !!props.process.live && props.process.startedAt !== undefined);
  createEffect(() => {
    if (!ticking()) return;
    setNow(clock());
    const timer = setInterval(() => setNow(clock()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const elapsed = () => {
    const { startedAt, endedAt } = props.process;
    const end = props.process.live ? now() : endedAt;
    return startedAt !== undefined && end !== undefined && Number.isFinite(startedAt) && Number.isFinite(end)
      ? formatElapsed(Math.max(0, end - startedAt - (props.process.idleMs ?? 0))) : null;
  };
  // owner 0 号图:「1m14s · 10 步」—— 时长后面跟这一段过程有几步(折起来的那些行一共几条)。
  const steps = () => {
    const count = props.process.steps;
    return count ? translate(count === 1 ? 'transcript.processStepsOne' : 'transcript.processSteps', { count }) : null;
  };
  const summary = () => [elapsed(), steps()].filter(Boolean).join(' · ') || null;
  const notice = () => commands().conversationProcessNotice?.(props.process.id);
  const label = () => notice()?.text ?? `${translate('transcript.thinkingAndExecution')}${summary() ? ` · ${summary()}` : ''}`;
  // 在跑:点阵代替大脑,字写「执行中 · 1m15s」并带微光(owner 2026-10-27 原型);跑完换回大脑 + 用时。
  const collapsible = () => props.collapsible !== false && !props.process.empty;
  const liveLabel = () => [translate('transcript.thinkingLive'), summary()].filter(Boolean).join(' · ');
  const layout = () => processButtonLayout(props.process, props.measureCtx());
  return <button type="button" class={conversationProcessButton} style={{ width: `${layout().width}px`, height: `${layout().height}px` }} data-conversation-process={props.process.id}
    disabled={!collapsible()} data-collapse-id={collapsible() ? props.process.id : undefined} data-collapse-anchor={props.anchorId}
    aria-expanded={collapsible() ? props.expanded : undefined} aria-label={label()} title={label()}>
    <Show when={!props.process.live} fallback={<><GridLoader /><ShimmerText active multiline style={{ 'white-space': 'normal', 'overflow-wrap': 'anywhere', 'min-width': 0, 'line-height': '22px' }}>{liveLabel()}</ShimmerText></>}>
      <svg width="17" height="17" viewBox="0 0 24 22" fill="none" stroke="currentColor" stroke-width="1.4"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M11.5 4.5C10 2 6 2 5 5c-3-.2-4 3-2.5 5-2 2 .1 5 2.5 4.5-.2 3 4.5 4.5 6.5 2M11.5 4.5C13 2 17 2 18 5c3-.2 4 3 2.5 5 2 2-.1 5-2.5 4.5.2 3-4.5 4.5-6.5 2V4.5Z" />
        <path d="m6 7 2 2-1 3m9-5-2 2 1 3M8 9h7" /><circle cx="7" cy="13" r=".6" /><circle cx="16" cy="13" r=".6" />
      </svg>
      <Show when={summary()}>{value => <span style={{ 'white-space': 'normal', 'overflow-wrap': 'anywhere', 'min-width': 0, 'line-height': '22px' }}>{value()}</span>}</Show>
    </Show>
    <Show when={notice()}>{value => <span data-agent-conversation-message={value().id}>{value().text}</span>}</Show>
    <Show when={collapsible()}><span class={conversationProcessChevron} aria-hidden="true">›</span></Show>
  </button>;
}
