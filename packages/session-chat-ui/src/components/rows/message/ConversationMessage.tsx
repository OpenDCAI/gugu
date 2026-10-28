/** @jsxImportSource solid-js */
import { For, Show } from 'solid-js';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { useSelfIdentity, shownSender, isSelfAddress } from '@session-chat/lib/self-identity';
import { useChatTranslator } from '@session-chat/localization';
import { useChatName } from '@session-chat/lib/chat-name';
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
import { CONVERSATION_EXPAND_H, CONVERSATION_HEADER_H, CONVERSATION_PROCESS_H, CONVERSATION_NARRATION_H, CONVERSATION_QUOTE_H, hasConversationActions } from './conversation-body';
import { measureUserMessage } from './user-message-metrics';
import { userMessageActionsHeight, type MessageVars } from './metrics';
import { conversationRoot, conversationHeader, conversationName, conversationNarration, conversationQuote, conversationQuoteFrom, conversationTime, conversationProcessButton, conversationProcessChevron, conversationTimeSeparator } from './conversation-message.css';

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

/** agent 发出去的那条带了 reply_to_message_id ⇒ 气泡上方一行「谁 · 摘要」(owner 10-28);❌ 猜出来的不画。 */
function sentQuote(item: ChatMessage): NonNullable<ChatMessage['conversationReply']> | null {
  return item.role === 'assistant' && item.conversationPart !== 'head' && item.sentReplyTo && item.conversationReply ? item.conversationReply : null;
}

/** 引用里的摘要截短一点(owner 10-28「比现在短一点」);一行放不下再由 CSS 省略。 */
const QUOTE_CHARS = 24;
function quoteSummary(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > QUOTE_CHARS ? `${flat.slice(0, QUOTE_CHARS)}…` : flat;
}

function singleHeight(item: ChatMessage, ctx: MeasureCtx, vars: MessageVars): number {
  if (item.conversationNarration) return CONVERSATION_NARRATION_H;
  if (item.conversationPart === 'head') return HEADER_H + TIME_H + backgroundHeight(item, ctx);
  const quote = sentQuote(item) ? CONVERSATION_QUOTE_H : 0;
  const header = item.conversationPart === 'body' ? 0 : HEADER_H;
  const bodyVars = conversationVars(item, vars);
  // 时间、复制、编辑那一行照原气泡画在气泡下面(owner 定稿 0 号图);没有正文就没有气泡,也不留这一行。
  const actions = hasConversationActions(item) || isMessageEditing(item.id, ctx) ? 0 : userMessageActionsHeight(bodyVars);
  const bodyCtx = conversationContext(ctx);
  const body = measureUserMessage(item, bodyCtx, bodyVars);
  // 折着 ⇔ 展开量出来比现在高;那时气泡下面多一行「展开全文」。
  const folded = ctx.expandedId !== item.id && !isMessageEditing(item.id, ctx) && measureUserMessage(item, { ...bodyCtx, expandedId: item.id }, bodyVars) > body;
  return header + quote + body - actions + (folded ? CONVERSATION_EXPAND_H : 0) + (item.role === 'assistant' && item.conversationProcess ? TIME_H + backgroundHeight(item, ctx) : 0);
}

/** 后台任务挂在这条过程行上、单子又展开着 ⇒ 多出单子的高(挂在哪由 ChatRoot 算,见 MeasureCtx.background)。 */
export function backgroundHeight(item: { id: string }, ctx: MeasureCtx): number {
  const background = ctx.background;
  if (!background || background.ownerId !== item.id || !background.expanded) return 0;
  return backgroundTasksListHeight(background.commands.length + background.subagents.length);
}

/** Agent-centered view: assistant left, every incoming actor right. */
export function ConversationMessage(props: { data: ChatMessage; ctx: RenderCtx; vars: MessageVars }) {
  // 中途说的话:步骤之间一行灰字,放不下就省略(设计稿 0 号「五路排查都回来了……」)。
  // 同一条在跑完时会变成回复气泡(同一个 id),所以用 <Show> 跟着数据换,❌ 组件里一次性 if。
  return <Show when={!props.data.conversationNarration} fallback={
    <div class={conversationNarration} style={{ height: `${CONVERSATION_NARRATION_H}px`, 'line-height': `${CONVERSATION_NARRATION_H}px` }}
      data-conversation-narration={props.data.id} title={props.data.text}>{props.data.text.replace(/\s+/g, ' ').trim()}</div>
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
  const name = () => {
    if (subject()) return commands().conversationAgentName?.() ?? 'Agent';
    const sender = facts();
    if (!sender) return self()?.displayName ?? translate('transcript.deliveryUnknownSender');
    if (isSelfAddress(sender.fromId, self()) && self()?.displayName?.trim()) return self()!.displayName!.trim();
    return shownSender(sender.from, sender.fromId, self()) ?? translate('transcript.deliveryUnknownSender');
  };
  const chatName = useChatName();
  const quoteSender = (from: string | null, fromId: string | null) =>
    isSelfAddress(fromId, self()) && self()?.displayName?.trim() ? self()!.displayName!.trim() : shownSender(from, fromId, self());
  // 「群名 · 发送者 · 短摘要」;被引用那条来自私聊就没有群名。发送者是那条自己的发送者(agent 或真人),❌ 默认写成 agent。
  const quoteLabel = (quote: NonNullable<ChatMessage['conversationReply']>) => [
    quote.chatId ? chatName(quote.chatId) : null,
    // 发送者照抬头的写法:是本人就写本人的名字,❌ 信封里「验收员 (咕咕号 112615)」原样贴上(真机验收 10-28)。
    quote.self ? commands().conversationAgentName?.() ?? null : quoteSender(quote.from ?? null, quote.fromId ?? null),
  ].filter((part): part is string => Boolean(part?.trim())).join(' · ');
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
          <ConversationProcess process={process()} anchorId={props.data.id} expanded={turnProcessExpanded(process().live, props.ctx.viewState.isCollapsed(process().id))} />
          <ProcessBackgroundPill ownerId={props.data.id} ctx={props.ctx} />
        </div>
        <ProcessBackgroundList ownerId={props.data.id} ctx={props.ctx} />
      </>
    }</Show>
    <Show when={sentQuote(props.data)}>{quote =>
      <div class={conversationQuote} style={{ height: `${CONVERSATION_QUOTE_H}px` }} data-slot="conversation-quote"
        title={[quoteLabel(quote()), quote().text].filter(Boolean).join(' · ')}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M12.5 3v4.5a3 3 0 0 1-3 3H3m3.5-3.5L3 10.5 6.5 14" /></svg>
        <Show when={quoteLabel(quote())}>{label => <span class={conversationQuoteFrom}>{`${label()} ·`}</span>}</Show>
        <span>{quoteSummary(quote().text)}</span>
      </div>
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
