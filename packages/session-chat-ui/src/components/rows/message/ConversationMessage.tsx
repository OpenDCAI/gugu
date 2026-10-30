/** @jsxImportSource solid-js */
import { conversationSpeaker, messageReplyReference } from '@session-chat/state/conversation-density';
import { For, Show } from 'solid-js';
import { conversationHeaderLayout } from './conversation-header-layout';
export { conversationDestinationLayout } from './conversation-destination';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { useSelfIdentity, shownSender, isSelfAddress } from '@session-chat/lib/self-identity';
import { useChatTranslator } from '@session-chat/localization';
import { useChatName } from '@session-chat/lib/chat-name';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import type { ChatMessage } from '@session-chat/model';
import { turnProcessExpanded } from '@session-chat/state/turn-fold';
import { rowTranslator } from '../readable-label';
import { processRowHeight, backgroundPillLayout } from './process-row-layout';
import { ConversationProcess } from './ConversationProcess';
import { SenderName } from './SenderName';
import { conversationAgentTarget, messageSenderTarget, type MessageSenderTarget } from '@session-chat/lib/sender-target';
import { BackgroundTasksList, measuredBackgroundListHeight } from '../background-tasks/background-tasks-parts';
import { ShimmerText } from '@session-chat/components/primitives/ShimmerText';
import { BACKGROUND_TASKS_TOGGLE } from '@session-chat/state/flatten';
import { segmentItem } from './DeliveryCard';
import { isMessageEditing } from './message-editor-metrics';
import { UserMessageCard } from './UserMessageCard';
import { ConversationReplyReference } from './ConversationReplyReference';
import { CONVERSATION_EXPAND_H, CONVERSATION_FOOTER_H, conversationBubbleKey, hasConversationActions } from './conversation-body';
export { isConversationMessage } from './conversation-body';
import { ConversationNarration, conversationNarrationHeight } from './ConversationNarration';
import { measureUserMessage } from './user-message-metrics';
import { userMessageActionsHeight, type MessageVars } from './metrics';
import { conversationRoot, conversationHeader, conversationName, conversationTime, conversationProcessButton, conversationProcessChevron, conversationTimeSeparator, conversationReferenceSeparator } from './conversation-message.css';

import { CONVERSATION_PREVIEW_MAX_H } from '@session-chat/components/engine/row-metrics';

export function conversationContext(ctx: MeasureCtx, item?: ChatMessage): MeasureCtx {
  return { ...ctx,
    ...(item ? { expandedId: ctx.latestConversationMessageId === item.id || ctx.expanded(conversationBubbleKey(item)) ? item.id : null } : {}),
    theme: { ...ctx.theme, layout: { ...ctx.theme.layout, preset: 'double', userGutter: Math.max(32, Math.round(ctx.width * .14)) } } };
}

export function conversationVars(item: ChatMessage, vars: MessageVars): MessageVars {
  const long = !item.conversationFull && (item.text.length > 700 || item.text.split('\n').length > 10);
  return { ...vars, footerH: CONVERSATION_FOOTER_H, collapsedMaxH: long ? CONVERSATION_PREVIEW_MAX_H : Number.MAX_SAFE_INTEGER, expandedMaxH: Number.MAX_SAFE_INTEGER };
}

function segments(item: ChatMessage): ChatMessage[] {
  const batch = item.guguDelivery?.segments;
  return batch && batch.length > 1 ? batch.map((segment, index) => {
    const reply = segment.facts?.replyTo;
    return { ...segmentItem(item, segment, index), conversationReply: reply ? {
      itemId: reply.messageId.replace(/^msg:/, ''), text: reply.preview ?? '',
      ...(reply.from ? { from: reply.from } : {}), ...(reply.fromId ? { fromId: reply.fromId } : {}), unloaded: true,
    } : undefined, conversationPreviousSpeaker: index ? conversationSpeaker(segmentItem(item, batch[index - 1]!, index - 1)) : item.conversationPreviousSpeaker };
  }) : [item];
}

export function conversationMessageHeight(item: ChatMessage, ctx: MeasureCtx, vars: MessageVars): number {
  return segments(item).reduce((height, segment, index) => height + singleHeight(segment, ctx, vars) + (index ? 12 : 0), 0);
}

/** Only an explicit IM reply or persisted timeline source gets a clickable quote. */
function messageQuote(item: ChatMessage): NonNullable<ChatMessage['conversationReply']> | null {
  return messageReplyReference(item) ?? null;
}

export function conversationSenderName(item: ChatMessage, ctx: MeasureCtx): string {
  const self = ctx.selfIdentity ?? null, t = rowTranslator(ctx);
  if (item.role === 'assistant') return ctx.commands?.conversationAgentName?.() ?? 'Agent';
  const sender = item.guguDelivery?.segments[0]?.facts;
  if (!sender) return self?.displayName ?? t('transcript.deliveryUnknownSender');
  if (isSelfAddress(sender.fromId, self) && self?.displayName?.trim()) return self.displayName.trim();
  return shownSender(sender.from, sender.fromId, self) ?? t('transcript.deliveryUnknownSender');
}
function replySenderLabel(quote: NonNullable<ChatMessage['conversationReply']>, ctx: MeasureCtx) {
  const self = ctx.selfIdentity ?? null;
  const sender = isSelfAddress(quote.fromId ?? null, self) && self?.displayName?.trim() ? self.displayName.trim() : shownSender(quote.from ?? null, quote.fromId ?? null, self);
  return [quote.chatId ? ctx.chatName?.(quote.chatId) : null,
    quote.self ? ctx.commands?.conversationAgentName?.() ?? null : sender]
    .filter((part): part is string => Boolean(part?.trim())).join(' · ');
}
function headerLayout(item: ChatMessage, ctx: MeasureCtx) {
  return conversationHeaderLayout(item, ctx, conversationSenderName(item, ctx));
}

function singleHeight(item: ChatMessage, ctx: MeasureCtx, vars: MessageVars): number {
  if (item.conversationNarration) return conversationNarrationHeight(item, ctx);
  if (item.conversationPart === 'head') {
    const head = headerLayout(item, ctx);
    return head.height + backgroundHeight(item, ctx) + (head.referenceInFooter ? measureUserMessage(item, conversationContext(ctx, item), conversationVars(item, vars)) : 0);
  }
  const header = item.conversationPart === 'body' ? 0 : headerLayout(item, ctx).height;
  const bodyVars = conversationVars(item, vars);
  // 时间、复制、编辑那一行照原气泡画在气泡下面(owner 定稿 0 号图);没有正文就没有气泡,也不留这一行。
  const actions = hasConversationActions(item) || headerLayout(item, ctx).referenceInFooter || isMessageEditing(item.id, ctx) ? 0 : userMessageActionsHeight(bodyVars);
  const bodyCtx = conversationContext(ctx, item);
  const body = measureUserMessage(item, bodyCtx, bodyVars);
  // 折着 ⇔ 展开量出来比现在高;那时气泡下面多一行「展开全文」。
  const folded = bodyCtx.expandedId !== item.id && !isMessageEditing(item.id, ctx) && measureUserMessage(item, { ...bodyCtx, expandedId: item.id }, bodyVars) > body;
  const canCollapse = ctx.expanded(conversationBubbleKey(item)) && ctx.latestConversationMessageId !== item.id
    && measureUserMessage(item, { ...bodyCtx, expandedId: null }, bodyVars) < body;
  return header + body - actions + (folded || canCollapse ? CONVERSATION_EXPAND_H : 0) + (item.role === 'assistant' && item.conversationProcess ? backgroundHeight(item, ctx) : 0);
}

/** 后台任务挂在这条过程行上、单子又展开着 ⇒ 多出单子的高(挂在哪由 ChatRoot 算,见 MeasureCtx.background)。 */
export function backgroundHeight(item: { id: string }, ctx: MeasureCtx): number {
  const background = ctx.background;
  if (!background || background.ownerId !== item.id || !background.expanded) return 0;
  return measuredBackgroundListHeight(background.commands, background.subagents, ctx);
}

/** Agent-centered view: assistant left, every incoming actor right. */
export function ConversationMessage(props: { data: ChatMessage; ctx: RenderCtx; vars: MessageVars }) {
  // 中途说的话:步骤之间一行灰字,放不下就省略(设计稿 0 号「五路排查都回来了……」)。
  // 同一条在跑完时会变成回复气泡(同一个 id),所以用 <Show> 跟着数据换,❌ 组件里一次性 if。
  return <Show when={!props.data.conversationNarration} fallback={
    <ConversationNarration data={props.data} ctx={props.ctx} />
  }>
    <Show when={(props.data.guguDelivery?.segments.length ?? 0) > 1} fallback={<SingleConversationMessage {...props} />}>
      <For each={segments(props.data)}>{(segment, index) => <div style={{ 'margin-top': index() ? '12px' : '0' }}><SingleConversationMessage {...props} data={segment} /></div>}</For>
    </Show>
  </Show>;
}

function SingleConversationMessage(props: { data: ChatMessage; ctx: RenderCtx; vars: MessageVars }) {
  const self = useSelfIdentity();
  const commands = useCommands();
  const translate = useChatTranslator();
  const facts = () => props.data.guguDelivery?.segments[0]?.facts;
  const subject = () => props.data.role === 'assistant';
  const measuredCtx = () => ({ ...props.ctx.measureCtx!(), selfIdentity: self(), commands: commands(), translate, chatName });
  const name = () => conversationSenderName(props.data, measuredCtx());
  const head = () => headerLayout(props.data, measuredCtx());
  const chatName = useChatName();
  const senderTarget = (): MessageSenderTarget | null => {
    if (subject()) return conversationAgentTarget({ sessionId: commands().conversationAgentSession?.(), userId: commands().conversationAgentUserId?.() });
    return messageSenderTarget(facts()) ?? (!facts() && self()?.userId ? { kind: 'sender', userId: self()!.userId } : null);
  };
  const quoteLabel = (quote: NonNullable<ChatMessage['conversationReply']>) => replySenderLabel(quote, measuredCtx());
  const reference = () => <Show when={messageQuote(props.data)}>{quote => <ConversationReplyReference itemId={quote().itemId}
    text={`${quoteLabel(quote()) ? `${quoteLabel(quote())}：` : ''}${quote().text || translate('transcript.showOriginalMessage')}`} />}</Show>;
  const bodyCtx: RenderCtx = { ...props.ctx, measureCtx: () => conversationContext(props.ctx.measureCtx!(), props.data) };
  return <div class={conversationRoot} data-agent-conversation-message={props.data.id} data-side={subject() ? 'left' : 'right'}
    data-conversation-part={props.data.conversationPart}>
    <Show when={props.data.conversationPart !== 'body' && head().height > 0}>
    <div class={conversationHeader} style={{ height: `${head().height}px` }}>
      <Show when={head().name}>{label => <SenderName class={conversationName} name={label().text} target={senderTarget()} style={{ width: `${head().nameWidth}px` }} />}</Show>
      {reference()}
      <Show when={messageQuote(props.data) && subject() && props.data.conversationProcess}>
        <span class={conversationReferenceSeparator} data-slot="conversation-reference-separator" aria-hidden="true">·</span>
      </Show>
      <Show when={subject() && props.data.conversationProcess}>{process =>
        <div class={conversationTime} style={{ width: `${head().processWidth}px`, height: `${processRowHeight(props.data.id, process(), head().processCtx)}px` }}>
          <ConversationProcess measureCtx={() => head().processCtx} process={process()} anchorId={props.data.id} expanded={turnProcessExpanded(process().live, props.ctx.viewState.isCollapsed(process().id))} />
          <ProcessBackgroundPill ownerId={props.data.id} ctx={{ ...props.ctx, measureCtx: () => head().processCtx }} />
        </div>
      }</Show>
    </div>
    </Show>
    <Show when={subject() && props.data.conversationProcess}>
      <ProcessBackgroundList ownerId={props.data.id} ctx={props.ctx} />
    </Show>
    <Show when={props.data.conversationPart !== 'head' || head().referenceInFooter}>
      <UserMessageCard data={props.data} ctx={bodyCtx} vars={conversationVars(props.data, props.vars)} conversation sender={name}
        footerReference={head().referenceInFooter ? reference : undefined} />
    </Show>
  </div>;
}

function attachedBackground(ownerId: string, ctx: RenderCtx) {
  const attached = ctx.measureCtx?.().background;
  return attached && attached.ownerId === ownerId ? attached : null;
}

/** 还在跑的后台任务与过程行同一行(owner 2026-10-27 原型):回复的头、只有过程的那一行(turn-process)都用这一颗。 */
export function ProcessBackgroundPill(props: { ownerId: string; ctx: RenderCtx }) {
  return <Show when={attachedBackground(props.ownerId, props.ctx)}>{tasks =>
    <span style={{ display: 'inline-flex', 'align-items': 'center', gap: '9px', 'margin-left': '-9px', 'padding-left': '9px', 'box-sizing': 'border-box' }}>
      <span class={conversationTimeSeparator} aria-hidden="true" />
      <button type="button" class={conversationProcessButton} data-slot="background-tasks-pill"
        style={{ width: `${backgroundPillLayout(props.ownerId, props.ctx.measureCtx!())!.width}px`, height: `${backgroundPillLayout(props.ownerId, props.ctx.measureCtx!())!.height}px` }}
        data-collapse-id={BACKGROUND_TASKS_TOGGLE} data-collapse-anchor={props.ownerId} aria-expanded={tasks().expanded}>
        <ShimmerText active multiline style={{ 'white-space': 'pre-wrap', 'line-height': '22px', 'min-width': 0 }}>{backgroundPillLayout(props.ownerId, props.ctx.measureCtx!())!.text}</ShimmerText>
        <span class={conversationProcessChevron} aria-hidden="true">›</span>
      </button>
    </span>
  }</Show>;
}

/** 单子就地展开在过程行下面(高度见 `backgroundHeight`)。 */
export function ProcessBackgroundList(props: { ownerId: string; ctx: RenderCtx }) {
  return <Show when={attachedBackground(props.ownerId, props.ctx)?.expanded ? attachedBackground(props.ownerId, props.ctx) : null}>{tasks =>
    <BackgroundTasksList commands={tasks().commands} subagents={tasks().subagents} measureCtx={props.ctx.measureCtx!} />
  }</Show>;
}
