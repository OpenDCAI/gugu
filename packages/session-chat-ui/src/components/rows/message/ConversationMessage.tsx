/** @jsxImportSource solid-js */
import { For, Show } from 'solid-js';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { useSelfIdentity, shownSender, isSelfAddress } from '@session-chat/lib/self-identity';
import { useChatTranslator } from '@session-chat/localization';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import type { ChatMessage } from '@session-chat/model';
import { turnProcessExpanded } from '@session-chat/state/turn-fold';
import { ConversationProcess } from './ConversationProcess';
import { BackgroundTasksList, backgroundTasksLabel, backgroundTasksListHeight } from '../background-tasks/background-tasks-parts';
import { ShimmerText } from '@session-chat/components/primitives/ShimmerText';
import { BACKGROUND_TASKS_TOGGLE } from '@session-chat/state/flatten';
import { segmentItem } from './DeliveryCard';
import { isMessageEditing } from './message-editor-metrics';
import { UserMessageCard } from './UserMessageCard';
import { CONVERSATION_EXPAND_H, CONVERSATION_HEADER_H, CONVERSATION_PROCESS_H, hasConversationBody } from './conversation-body';
import { measureUserMessage } from './user-message-metrics';
import { userMessageActionsHeight, type MessageVars } from './metrics';
import { conversationRoot, conversationHeader, conversationName, conversationTime, conversationProcessButton, conversationProcessChevron, conversationTimeSeparator } from './conversation-message.css';

const HEADER_H = CONVERSATION_HEADER_H;
const TIME_H = CONVERSATION_PROCESS_H;

export function isConversationMessage(item: ChatMessage, ctx: MeasureCtx): boolean {
  if (!ctx.theme.layout?.agentConversation || item.hookNotice || item.questionAnswer || item.role === 'thought') return false;
  return !item.guguDelivery || item.guguDelivery.segments.every(segment => segment.facts?.route === 'chat' || segment.facts?.route === 'session-direct');
}

export function conversationContext(ctx: MeasureCtx): MeasureCtx {
  return { ...ctx, theme: { ...ctx.theme, layout: { ...ctx.theme.layout, preset: 'double', userGutter: Math.max(32, Math.round(ctx.width * .14)) } } };
}

export function conversationVars(item: ChatMessage, vars: MessageVars): MessageVars {
  return item.role === 'assistant' ? { ...vars, collapsedMaxH: Number.MAX_SAFE_INTEGER, expandedMaxH: Number.MAX_SAFE_INTEGER } : vars;
}

function segments(item: ChatMessage): ChatMessage[] {
  const batch = item.guguDelivery?.segments;
  return batch && batch.length > 1 ? batch.map((segment, index) => ({ ...segmentItem(item, segment, index), conversationReply: undefined })) : [item];
}

export function conversationMessageHeight(item: ChatMessage, ctx: MeasureCtx, vars: MessageVars): number {
  return segments(item).reduce((height, segment, index) => height + singleHeight(segment, ctx, vars) + (index ? 12 : 0), 0);
}

function singleHeight(item: ChatMessage, ctx: MeasureCtx, vars: MessageVars): number {
  if (item.conversationPart === 'head') return HEADER_H + TIME_H + backgroundHeight(item, ctx);
  const header = item.conversationPart === 'body' ? 0 : HEADER_H;
  const bodyVars = conversationVars(item, vars);
  // 时间、复制、编辑那一行照原气泡画在气泡下面(owner 定稿 0 号图);没有正文就没有气泡,也不留这一行。
  const actions = hasConversationBody(item) || isMessageEditing(item.id, ctx) ? 0 : userMessageActionsHeight(bodyVars);
  const bodyCtx = conversationContext(ctx);
  const body = measureUserMessage(item, bodyCtx, bodyVars);
  // 折着 ⇔ 展开量出来比现在高;那时气泡下面多一行「展开全文」。
  const folded = ctx.expandedId !== item.id && !isMessageEditing(item.id, ctx) && measureUserMessage(item, { ...bodyCtx, expandedId: item.id }, bodyVars) > body;
  return header + body - actions + (folded ? CONVERSATION_EXPAND_H : 0) + (item.role === 'assistant' && item.conversationProcess ? TIME_H + backgroundHeight(item, ctx) : 0);
}

/** 后台任务挂在这条过程行上、单子又展开着 ⇒ 多出单子的高(挂在哪由 ChatRoot 算,见 MeasureCtx.background)。 */
export function backgroundHeight(item: { id: string }, ctx: MeasureCtx): number {
  const background = ctx.background;
  if (!background || background.ownerId !== item.id || !background.expanded) return 0;
  return backgroundTasksListHeight(background.commands.length + background.subagents.length);
}

/** Agent-centered view: assistant left, every incoming actor right. */
export function ConversationMessage(props: { data: ChatMessage; ctx: RenderCtx; vars: MessageVars }) {
  return <Show when={(props.data.guguDelivery?.segments.length ?? 0) > 1} fallback={<SingleConversationMessage {...props} />}>
    <For each={segments(props.data)}>{(segment, index) => <div style={{ 'margin-top': index() ? '12px' : '0' }}><SingleConversationMessage {...props} data={segment} /></div>}</For>
  </Show>;
}

function SingleConversationMessage(props: { data: ChatMessage; ctx: RenderCtx; vars: MessageVars }) {
  const self = useSelfIdentity();
  const commands = useCommands();
  const translate = useChatTranslator();
  const facts = () => props.data.guguDelivery?.segments[0]?.facts;
  const subject = () => props.data.role === 'assistant';
  const name = () => {
    if (subject()) return commands().conversationAgentName?.() ?? 'Agent';
    const sender = facts();
    if (!sender) return self()?.displayName ?? translate('transcript.deliveryUnknownSender');
    if (isSelfAddress(sender.fromId, self()) && self()?.displayName?.trim()) return self()!.displayName!.trim();
    return shownSender(sender.from, sender.fromId, self()) ?? translate('transcript.deliveryUnknownSender');
  };
  const bodyCtx: RenderCtx = { ...props.ctx, measureCtx: () => conversationContext(props.ctx.measureCtx!()) };
  return <div class={conversationRoot} data-agent-conversation-message={props.data.id} data-side={subject() ? 'left' : 'right'}
    data-conversation-part={props.data.conversationPart}>
    <Show when={props.data.conversationPart !== 'body'}>
    <div class={conversationHeader} style={{ height: `${HEADER_H}px` }}>
      <span class={conversationName} title={name()}>{name()}</span>
      {/* owner 0 号图:名字那一行只写名字 —— ❌ 后面再跟被回复那条的摘要(管家 10-28 定)。 */}
    </div>
    </Show>
    {/* owner 2026-10-27 原型:过程行在气泡上方(正文流式长高时它不挪窝);还在跑的后台任务与它同一行,单子就地展开在它下面。 */}
    <Show when={subject() && props.data.conversationProcess}>{process =>
      <>
        <div class={conversationTime} style={{ height: `${TIME_H}px` }}>
          <ConversationProcess process={process()} anchorId={props.data.id} expanded={turnProcessExpanded(process().live, props.ctx.viewState.isCollapsed(process().id), true)} />
          <ProcessBackgroundPill ownerId={props.data.id} ctx={props.ctx} />
        </div>
        <ProcessBackgroundList ownerId={props.data.id} ctx={props.ctx} />
      </>
    }</Show>
    <Show when={props.data.conversationPart !== 'head'}>
      <UserMessageCard data={props.data} ctx={bodyCtx} vars={conversationVars(props.data, props.vars)} conversation />
    </Show>
  </div>;
}

function attachedBackground(ownerId: string, ctx: RenderCtx) {
  const attached = ctx.measureCtx?.().background;
  return attached && attached.ownerId === ownerId ? attached : null;
}

/** 还在跑的后台任务与过程行同一行(owner 2026-10-27 原型):回复的头、只有过程的那一行(turn-process)都用这一颗。 */
export function ProcessBackgroundPill(props: { ownerId: string; ctx: RenderCtx }) {
  const translate = useChatTranslator();
  return <Show when={attachedBackground(props.ownerId, props.ctx)}>{tasks =>
    <>
      <span class={conversationTimeSeparator} aria-hidden="true" />
      <button type="button" class={conversationProcessButton} data-slot="background-tasks-pill"
        data-collapse-id={BACKGROUND_TASKS_TOGGLE} data-collapse-anchor={props.ownerId} aria-expanded={tasks().expanded}>
        <ShimmerText active>{backgroundTasksLabel(translate, tasks().commands.length, tasks().subagents.length)}</ShimmerText>
        <span class={conversationProcessChevron} aria-hidden="true">›</span>
      </button>
    </>
  }</Show>;
}

/** 单子就地展开在过程行下面(高度见 `backgroundHeight`)。 */
export function ProcessBackgroundList(props: { ownerId: string; ctx: RenderCtx }) {
  return <Show when={attachedBackground(props.ownerId, props.ctx)?.expanded ? attachedBackground(props.ownerId, props.ctx) : null}>{tasks =>
    <BackgroundTasksList commands={tasks().commands} subagents={tasks().subagents} />
  }</Show>;
}
