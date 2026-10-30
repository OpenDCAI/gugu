/** @jsxImportSource solid-js */
/**
 * A delivered input uses the ordinary user-message body. One quiet source line
 * identifies its sender/channel; envelope details remain inspectable there.
 * Delivery routing, prompt identity and scroll behaviour stay separate from paint.
 */
import type { DeliveryReadFacts, DeliverySegment } from '@gugu/core/local/agent/deliveryEnvelope';
import { readableLabel, rowTranslator, wrappedRowHeight } from '../readable-label';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import { useChatTranslator, type ChatTranslator } from '@session-chat/localization';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { isSelfAddress, shownSender, useSelfIdentity } from '@session-chat/lib/self-identity';
import { useSenderAvatar, useSenderName } from '@session-chat/lib/sender-avatar';
import { useAppName } from '@session-chat/lib/app-name';
import { useChatName } from '@session-chat/lib/chat-name';
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink';
import { composerCardPreview } from '@gugu/core/shared/ui/taskCardModels';
import type { ChatMessage } from '@session-chat/model';
import { pxTokens } from '@session-chat/styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { For, Show, createMemo, createSignal } from 'solid-js';
import { UserMessageCard } from './UserMessageCard';
import { SenderName } from './SenderName';
import { messageSenderTarget } from '@session-chat/lib/sender-target';
import { splitAttachmentMentions } from '@session-chat/core/markdown/attachment-mentions';
import { userAvailableWidth, type MessageVars } from './metrics';
import { estimateUserMessage, measureUserMessage } from './user-message-metrics';
import {
  deliveryAvatar,
  deliveryAvatarImage,
  deliveryFactLabel,
  deliveryFactValue,
  deliveryFacts,
  deliveryFactsToggle,
  deliveryHeader,
  deliveryReply,
  deliveryRoot,
  deliveryRoute,
  deliverySender,
  deliveryVars,
} from './delivery-card.css';

export type DeliveryVars = {
  padY: number;
  /** Vertical gap between bands. */
  gap: number;
  /** Extra height on top of one body line for the header band. */
  headerExtraH: number;
  /** Avatar diameter. */
  avatar: number;
  /** Vertical padding inside the facts band (each side). */
  factsPadY: number;
};

export const DELIVERY_VARS: DeliveryVars = {
  padY: 4,
  gap: 6,
  headerExtraH: 4,
  avatar: 18,
  factsPadY: 6,
};

export function deliveryFactsId(messageId: string): string {
  return `${messageId}:delivery-facts`;
}

export type DeliveryFactEntry = {
  /** Suffix of the `transcript.deliveryFact.*` translation key. */
  key: 'at' | 'sender' | 'route' | 'whisperTo' | 'viaApp' | 'thread' | 'message' | 'listen' | 'then' | 'replyTo' | 'threadContext' | 'messageContext';
  value: string;
};

/**
 * The details-tier rows, in reading order: only facts the envelope actually
 * carried, one row each. The header already shows `from` and the route
 * label, so here the sender row adds the id and the route row the raw chat
 * anchor — the things a person asks for when a delivery looks wrong.
 */
export function deliveryFactEntries(facts: DeliveryReadFacts): DeliveryFactEntry[] {
  const entries: DeliveryFactEntry[] = [];
  const push = (key: DeliveryFactEntry['key'], value: string | null | undefined) => {
    if (value) entries.push({ key, value });
  };
  push('at', facts.at);
  push('sender', facts.from && facts.fromId ? `${facts.from} · ${facts.fromId}` : (facts.from ?? facts.fromId));
  push(
    'route',
    [facts.route, facts.chat ? `${facts.chatKind ?? 'chat'} ${facts.chat}` : null].filter(Boolean).join(' · ')
  );
  push('whisperTo', facts.whisperTo);
  push('viaApp', facts.viaApp);
  push('thread', facts.thread);
  push('message', facts.messageId);
  push('listen', facts.listenMode);
  push('then', facts.then);
  // session-direct 只带发信方说的那条 msg(没有预览);chat 带被引用的整条。
  push('replyTo', facts.inReplyTo);
  if (facts.replyTo) push('replyTo', `${facts.replyTo.messageId} · ${facts.replyTo.from ?? facts.replyTo.fromId}`);
  push('threadContext', facts.threadContext);
  push('messageContext', facts.messageContext);
  return entries;
}

type Bands = {
  headerH: number;
  replyH: number;
  bodyH: number;
  factsH: number;
  total: number;
};

/** One card per segment of a batch; measure, estimate and render all build it here so their geometry agrees. */
export function segmentItem(item: ChatMessage, segment: DeliverySegment, index: number): ChatMessage {
  const split = splitAttachmentMentions(segment.body);
  const original = item.attachments?.filter(attachment => attachment.id === `gugu-message-file://${segment.facts?.messageId?.replace(/^msg:/, '')}`) ?? [];
  const attachments = original.length ? original : split.attachments.map((attachment) =>
    item.attachments?.find((stored) => stored.id === attachment.id) ?? attachment
  );
  return {
    ...item, id: `${item.id}:batch-${index}`, text: split.text, attachments,
    guguDelivery: { body: segment.body, segments: [segment] },
  };
}

/** A card stands for one delivery; a batch renders as one card per segment before reaching here. */
function cardFacts(item: ChatMessage): DeliveryReadFacts | null {
  const segments = item.guguDelivery?.segments;
  return segments?.length === 1 ? segments[0]!.facts : null;
}

/**
 * What the details tier holds. Empty (the facts-less nested spelling) means
 * there is no details band and no toggle — measure and render key off the
 * same reading, so the height contract holds even when the collapse id is open.
 */
function deliveryDetails(item: ChatMessage): DeliveryFactEntry[] {
  const facts = cardFacts(item);
  return facts ? deliveryFactEntries(facts) : [];
}

function sourceLayout(item: ChatMessage, ctx: MeasureCtx, vars: DeliveryVars) {
  const facts = cardFacts(item), t = rowTranslator(ctx), self = ctx.selfIdentity ?? null;
  const named = facts ? isSelfAddress(facts.fromId, self) ? t('transcript.deliveryFromMe') : ctx.senderName?.(facts.fromId) ?? shownSender(facts.from, facts.fromId, self) : null;
  const sender = named || t(facts ? 'transcript.deliveryUnknownSender' : 'transcript.deliveryLegacySender');
  const route = facts ? routeLabel(facts, t, { appName: ctx.appName ?? (() => null), chatName: ctx.chatName ?? (() => null) }) : '';
  const width = userAvailableWidth(ctx.width, ctx.theme.layout), line = ctx.theme.fonts.body.lineHeight;
  const name = readableLabel(sender, ctx, width - vars.avatar - 8, 12, line);
  const via = readableLabel(route, ctx, width - 20, 12, line);
  const parts = [{ width: vars.avatar, height: vars.avatar }, { width: Math.min(width - vars.avatar - 8, name.width), height: name.height }];
  if (route) parts.push({ width: Math.min(width - 20, via.width), height: via.height });
  if (deliveryDetails(item).length) parts.push({ width: 12, height: line });
  return { name, via, height: wrappedRowHeight(parts, width, 8) + vars.headerExtraH };
}

function detailValueLayout(item: ChatMessage, entry: DeliveryFactEntry, ctx: MeasureCtx) {
  const t = rowTranslator(ctx), lineH = ctx.theme.fonts.body.lineHeight;
  const labels = deliveryDetails(item).map(row => readableLabel(t(`transcript.deliveryFact.${row.key}`), ctx, ctx.width, 14, lineH).width);
  const width = userAvailableWidth(ctx.width, ctx.theme.layout) - 16 - 12 - Math.max(0, ...labels);
  return readableLabel(entry.value, ctx, width, 14, lineH);
}
function detailsHeight(item: ChatMessage, ctx: MeasureCtx, vars: DeliveryVars): number {
  const entries = deliveryDetails(item);
  return entries.length ? entries.reduce((sum, entry) => sum + detailValueLayout(item, entry, ctx).height, 0) + 2 * vars.factsPadY : 0;
}
function replyLayout(item: ChatMessage, ctx: MeasureCtx) {
  const reply = cardFacts(item)?.replyTo;
  if (!reply || ctx.commands?.onConversationReply) return null;
  const text = rowTranslator(ctx)('transcript.deliveryReplyTo', {
    from: (isSelfAddress(reply.fromId, ctx.selfIdentity ?? null) ? shownSender(reply.from, reply.fromId, ctx.selfIdentity ?? null) : ctx.senderName?.(reply.fromId) ?? shownSender(reply.from, reply.fromId, ctx.selfIdentity ?? null)) ?? reply.fromId,
    preview: quotedWords(reply.preview),
  });
  return readableLabel(text, ctx, userAvailableWidth(ctx.width, ctx.theme.layout) - 10, 12, ctx.theme.fonts.body.lineHeight);
}

/** Chat/session inputs already have a single conversation identity in the pane header. */
function bodyOnly(item: ChatMessage): boolean {
  const route = cardFacts(item)?.route;
  return route === 'chat' || route === 'session-direct';
}

function bands(item: ChatMessage, ctx: MeasureCtx, vars: DeliveryVars, messageVars: MessageVars, factsOpen: boolean): Bands {
  if (bodyOnly(item)) return { headerH: 0, replyH: 0, bodyH: measureUserMessage(item, ctx, messageVars), factsH: 0, total: 2 * vars.padY + measureUserMessage(item, ctx, messageVars) };
  const lineH = ctx.theme.fonts.body.lineHeight;
  const headerH = sourceLayout(item, ctx, vars).height;
  const replyH = cardFacts(item)?.replyTo ? replyLayout(item, ctx)?.height ?? lineH : 0;
  const bodyH = measureUserMessage(item, ctx, messageVars);
  const factsH = factsOpen ? detailsHeight(item, ctx, vars) : 0;
  const total =
    2 * vars.padY +
    headerH +
    (replyH ? vars.gap + replyH : 0) +
    vars.gap +
    bodyH +
    (factsH ? vars.gap + factsH : 0);
  return { headerH, replyH, bodyH, factsH, total };
}

export function measureDelivery(item: ChatMessage, ctx: MeasureCtx, vars: DeliveryVars, messageVars: MessageVars): number {
  const batch = item.guguDelivery?.segments ?? [];
  if (batch.length > 1) {
    return batch.reduce((total, segment, index) => total
      + measureDelivery(segmentItem(item, segment, index), ctx, vars, messageVars)
      + (index > 0 ? vars.gap : 0), 0);
  }
  return bands(item, ctx, vars, messageVars, ctx.expanded(deliveryFactsId(item.id))).total;
}

export function estimateDelivery(item: ChatMessage, ctx: MeasureCtx, vars: DeliveryVars, messageVars: MessageVars): number {
  const batch = item.guguDelivery?.segments ?? [];
  if (batch.length > 1) {
    return batch.reduce((total, segment, index) => total
      + estimateDelivery(segmentItem(item, segment, index), ctx, vars, messageVars)
      + (index > 0 ? vars.gap : 0), 0);
  }
  if (bodyOnly(item)) return 2 * vars.padY + estimateUserMessage(item, ctx, messageVars);
  const lineH = ctx.theme.fonts.body.lineHeight;
  const replyH = cardFacts(item)?.replyTo ? vars.gap + lineH : 0;
  return 2 * vars.padY + lineH + vars.headerExtraH + replyH + vars.gap + estimateUserMessage(item, ctx, messageVars);
}

/**
 * 渠道一段，加上两格送法事实：App 代发、悄悄话（#6835）。手机与桌面同一张卡、同一句。
 * App 代发写它的名字（宿主按装着的 App、界面语言给）；这台没装就写 id。信封里留的是 id，详情里照样看得到。
 */
type Namers = { appName: (appId: string) => string | null; chatName: (chatId: string) => string | null };

function routeLabel(facts: DeliveryReadFacts, translate: ChatTranslator, { appName, chatName }: Namers): string {
  return [
    facts.viaApp ? translate('transcript.deliveryViaApp', { app: appName(facts.viaApp) ?? facts.viaApp }) : null,
    facts.whisperTo ? translate('transcript.deliveryWhisper') : null,
    channelLabel(facts, translate, chatName),
  ].filter(Boolean).join(' · ');
}

function channelLabel(facts: DeliveryReadFacts, translate: ChatTranslator, chatName: Namers['chatName']): string {
  if (facts.route === 'session-direct') return translate('transcript.deliveryViaSession');
  if (facts.route === 'system') return translate('transcript.deliveryFromGugu');
  // #7221 自己排的已安排到点,咕咕把交代送回来;信封带了是哪一条(那条的标题)就写出来,老信封没有这一格。
  if (facts.route === 'scheduled') {
    return facts.schedule
      ? translate('transcript.deliveryScheduledTitled', { title: facts.schedule })
      : translate('transcript.deliveryScheduled');
  }
  // 集体记忆对账第 12 条:App 的投递只有一种语义(没有「附带」那一档),标签也就一个。
  if (facts.route === 'extension') return translate('transcript.deliveryViaExtension');
  if (facts.route === 'forum') return translate('transcript.deliveryViaForum');
  // 信封里的 chat 是群号(给 agent 寻址用的),人读群名:按来源链接里的对话 id 向宿主要名字(项目群就是项目名);
  // 宿主不认得这个群就只说「来自群聊」,❌ 把群号写给人看。
  if (facts.chatKind === 'group') {
    const chatId = facts.sourceLink ? parseConversationLink(facts.sourceLink)?.chatId : undefined;
    const name = chatId ? chatName(chatId) : null;
    return name ? translate('transcript.deliveryViaGroup', { chat: name }) : translate('transcript.deliveryViaUnnamedGroup');
  }
  return translate('transcript.deliveryViaChat');
}

const quotedWords = (preview: string): string => composerCardPreview(preview)?.text ?? preview;

export function DeliveryCard(props: { data: ChatMessage; ctx: RenderCtx; vars: DeliveryVars; messageVars: MessageVars }) {
  const batch = () => props.data.guguDelivery?.segments ?? [];
  return (
    <Show when={batch().length > 1} fallback={<SingleDelivery {...props} />}>
      <div data-delivery-batch={props.data.id}>
        <For each={batch()}>{(segment, index) => (
          <div style={{ 'margin-top': index() === 0 ? '0' : `${props.vars.gap}px` }}>
            <SingleDelivery
              data={segmentItem(props.data, segment, index())}
              ctx={props.ctx}
              vars={props.vars}
              messageVars={props.messageVars}
              anchorId={props.data.id}
            />
          </div>
        )}</For>
      </div>
    </Show>
  );
}

function SingleDelivery(props: {
  data: ChatMessage;
  ctx: RenderCtx;
  vars: DeliveryVars;
  messageVars: MessageVars;
  anchorId?: string;
}) {
  const translate = useChatTranslator();
  const commands = useCommands();
  const self = useSelfIdentity();
  const senderAvatar = useSenderAvatar();
  const senderName = useSenderName();
  const namers: Namers = { appName: useAppName(), chatName: useChatName() };
  const mCtx = () => {
    const ctx = props.ctx.measureCtx?.();
    return ctx ? { ...ctx, senderName } : undefined;
  };
  const factsId = () => deliveryFactsId(props.data.id);
  const factsOpen = () => props.ctx.viewState.isCollapsed(factsId());
  const facts = () => cardFacts(props.data);

  const geometry = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return null;
    return bands(props.data, ctx, props.vars, props.messageVars, factsOpen());
  });

  // The source line keeps its avatar slot stable when an identity arrives later. A URL that fails to load leaves the slot empty.
  const [failedAvatar, setFailedAvatar] = createSignal<string | null>(null);
  const avatarUrl = () => {
    const url = senderAvatar(facts()?.fromId ?? null);
    return url && url !== failedAvatar() ? url : null;
  };

  /**
   * The named sender, or null when the envelope names nobody (the nested legacy spelling). The signed-in user's own
   * words read 「我」 (gugu-dev#181「我 来自 官网」): they are reading their own session; who that is, the details say.
   */
  const namedSender = () => {
    const f = facts();
    if (!f) return null;
    return isSelfAddress(f.fromId, self()) ? translate('transcript.deliveryFromMe') : senderName(f.fromId) ?? shownSender(f.from, f.fromId, self());
  };

  const sender = () => {
    const named = namedSender();
    if (named) return named;
    return translate(facts() ? 'transcript.deliveryUnknownSender' : 'transcript.deliveryLegacySender');
  };

  const details = () => deliveryDetails(props.data);
  const hasDetails = () => details().length > 0;

  const source = () => mCtx() ? sourceLayout(props.data, { ...mCtx()!, translate, selfIdentity: self(), appName: namers.appName, chatName: namers.chatName }, props.vars) : null;
  const sourceContent = () => (<>
        <span class={deliveryAvatar} data-slot="delivery-avatar" data-avatar-state={avatarUrl() ? 'image' : 'empty'} aria-hidden="true">
          <Show when={avatarUrl()}>
            {(url) => (
              <img
                class={deliveryAvatarImage}
                src={url()}
                alt=""
                draggable={false}
                onError={() => {
                  console.error(`[DeliveryCard] avatar failed to load for ${facts()?.fromId ?? 'unknown sender'}`);
                  setFailedAvatar(url());
                }}
              />
            )}
          </Show>
        </span>
        <span data-slot="delivery-sender"><SenderName class={deliverySender} name={source()?.name.text ?? sender()} target={messageSenderTarget(facts())} /></span>
        <Show when={facts()}>{(f) => <span class={deliveryRoute} data-slot="delivery-route">{source()?.via.text ?? routeLabel(f(), translate, namers)}</span>}</Show>
  </>);

  const lineH = () => mCtx()?.theme.fonts.body.lineHeight ?? 20;

  return (
    <div
      data-delivery-card={props.data.id}
      data-delivery-route={facts()?.route ?? 'legacy'}
      data-facts-open={factsOpen() ? 'true' : 'false'}
      class={deliveryRoot}
      style={assignInlineVars(
        deliveryVars,
        pxTokens({
          height: geometry()?.total ?? 0,
          padY: props.vars.padY,
          headerH: geometry()?.headerH ?? lineH() + props.vars.headerExtraH,
          lineH: lineH(),
          factsH: geometry()?.factsH ?? 0,
          gap: props.vars.gap,
          avatar: props.vars.avatar,
          width: mCtx() ? userAvailableWidth(mCtx()!.width, mCtx()!.theme.layout) : 0,
        })
      )}
    >
      <Show when={!bodyOnly(props.data)}>
      <div class={deliveryHeader} data-slot="delivery-header">
        <div class={deliveryFactsToggle}>
          {sourceContent()}
        <Show when={hasDetails()}>
          <button
            type="button"
            class={deliveryFactsToggle}
            data-collapse-id={factsId()}
            data-collapse-anchor={props.anchorId ?? props.data.id}
            aria-expanded={factsOpen() ? 'true' : 'false'}
            aria-label={`${sender()} · ${facts() ? routeLabel(facts()!, translate, namers) : ''} · ${translate('transcript.deliveryDetails')}`}
            title={translate('transcript.deliveryDetails')}
          >
            <span aria-hidden="true">{factsOpen() ? '▾' : '▸'}</span>
          </button>
        </Show>
        </div>
      </div>
      <Show when={facts()?.replyTo}>
        {(reply) => (
          // A quoted card (a task, a question) reads as its words, not as the JSON it is stored as.
          <button type="button" class={deliveryReply} data-slot="delivery-reply" title={quotedWords(reply().preview)}
            style={!commands().onConversationReply && mCtx() ? { height: `${replyLayout(props.data, mCtx()!)?.height ?? lineH()}px`, 'white-space': 'pre-wrap', overflow: 'visible' } : undefined}
            disabled={!commands().onConversationReply} aria-label={translate('transcript.showOriginalMessage')}
            onClick={() => commands().onConversationReply?.(props.data.conversationReply?.itemId ?? reply().messageId)}>
            {replyLayout(props.data, { ...mCtx()!, commands: commands(), selfIdentity: self(), translate })?.text ?? translate('transcript.deliveryReplyTo', {
              from: (isSelfAddress(reply().fromId, self()) ? shownSender(reply().from, reply().fromId, self()) : senderName(reply().fromId) ?? shownSender(reply().from, reply().fromId, self())) ?? reply().fromId,
              preview: quotedWords(reply().preview),
            })}
          </button>
        )}
      </Show>
      </Show>
      <div data-gugu-body="visible" style={{ 'margin-top': bodyOnly(props.data) ? '0' : `${props.vars.gap}px` }}>
        <UserMessageCard data={props.data} ctx={props.ctx} vars={props.messageVars} />
      </div>
      <Show when={!bodyOnly(props.data) && factsOpen() && details().length > 0}>
        <div class={deliveryFacts} data-slot="delivery-facts" role="list">
          <For each={details()}>
            {(entry) => (
              <>
                <span class={deliveryFactLabel} data-fact-label={entry.key}>
                  {translate(`transcript.deliveryFact.${entry.key}`)}
                </span>
                <span class={deliveryFactValue} data-fact={entry.key} title={entry.value}>
                  {mCtx() ? detailValueLayout(props.data, entry, mCtx()!).text : entry.value}
                </span>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
