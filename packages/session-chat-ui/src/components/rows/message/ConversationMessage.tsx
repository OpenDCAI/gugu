/** @jsxImportSource solid-js */
import { For, Show } from 'solid-js';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { useSelfIdentity, shownSender, isSelfAddress } from '@session-chat/lib/self-identity';
import { useChatTranslator } from '@session-chat/localization';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import type { ChatMessage } from '@session-chat/model';
import { useTurnState } from '@session-chat/components/contexts/TurnStateContext';
import { turnProcessExpanded } from '@session-chat/state/turn-fold';
import { ConversationProcess } from './ConversationProcess';
import { segmentItem } from './DeliveryCard';
import { UserMessageActions } from './UserMessageActions';
import { isMessageEditing } from './message-editor-metrics';
import { UserMessageCard } from './UserMessageCard';
import { measureUserMessage } from './user-message-metrics';
import { userMessageActionsHeight, type MessageVars } from './metrics';
import { conversationRoot, conversationHeader, conversationName, conversationDivider, conversationQuote, conversationTime, conversationActions } from './conversation-message.css';

const HEADER_H = 24;
const TIME_H = 22;

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
  const bodyVars = conversationVars(item, vars);
  return HEADER_H + measureUserMessage(item, conversationContext(ctx), bodyVars) - (isMessageEditing(item.id, ctx) && !item.guguDelivery ? 0 : userMessageActionsHeight(bodyVars)) + (item.role === 'assistant' && item.conversationProcess ? TIME_H : 0);
}

/** Agent-centered view: assistant left, every incoming actor right. */
export function ConversationMessage(props: { data: ChatMessage; ctx: RenderCtx; vars: MessageVars }) {
  return <Show when={(props.data.guguDelivery?.segments.length ?? 0) > 1} fallback={<SingleConversationMessage {...props} />}>
    <For each={segments(props.data)}>{(segment, index) => <div style={{ 'margin-top': index() ? '12px' : '0' }}><SingleConversationMessage {...props} data={segment} /></div>}</For>
  </Show>;
}

function SingleConversationMessage(props: { data: ChatMessage; ctx: RenderCtx; vars: MessageVars }) {
  const self = useSelfIdentity();
  const turn = useTurnState();
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
  const quote = () => facts()?.replyTo?.preview ?? props.data.conversationReply?.text;
  const reference = () => props.data.conversationReply?.itemId;
  const bodyCtx: RenderCtx = { ...props.ctx, measureCtx: () => conversationContext(props.ctx.measureCtx!()) };
  const jump = (event: MouseEvent) => {
    event.stopPropagation();
    const id = reference();
    if (id) commands().onConversationReply?.(id);
  };
  return <div class={conversationRoot} data-agent-conversation-message={props.data.id} data-side={subject() ? 'left' : 'right'}>
    <div class={conversationHeader} style={{ height: `${HEADER_H}px` }}>
      <span class={conversationName} title={name()}>{name()}</span>
      <Show when={quote()}><span class={conversationDivider} /><button type="button" class={conversationQuote}
        title={quote()} onClick={jump} disabled={!reference()}>
        <span>{quote()}</span><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M12.5 3v4.5a3 3 0 0 1-3 3H3m3.5-3.5L3 10.5 6.5 14" /></svg>
      </button></Show>
    </div>
    <UserMessageCard data={props.data} ctx={bodyCtx} vars={conversationVars(props.data, props.vars)} conversation />
    <Show when={subject() && props.data.conversationProcess}>{process =>
      <div class={conversationTime} style={{ height: `${TIME_H}px` }}>
        <ConversationProcess process={process()} anchorId={props.data.id} expanded={turnProcessExpanded(process().live, props.ctx.viewState.isCollapsed(process().id))} />
      </div>
    }</Show>
    <div class={conversationActions}><UserMessageActions itemId={props.data.id} text={props.data.text}
      generating={turn.currentMessageId() === props.data.id && turn.turnStatus() === 'generating'}
      readOnly={subject() || Boolean(props.data.guguDelivery)} vars={{ ...props.vars, footerH: 18 }} /></div>
  </div>;
}
