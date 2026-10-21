/** @jsxImportSource solid-js */
import { StreamContext, type StreamAnimation } from '@session-chat/components/contexts/StreamContext';
import { BlockStackView } from '@session-chat/components/primitives/BlockStackView';
import { CopyButton } from '@session-chat/components/primitives/CopyButton';
import { proseLinesHeight } from '@session-chat/components/rows/markdown/html/layout';
import type { StackLayout } from '@session-chat/core/compose';
import type { MeasureCtx, Measured, RenderCtx } from '@session-chat/core/define';
import { layoutBlockStack } from '@session-chat/core/layout/block-stack';
import type { Block } from '@session-chat/core/markdown/document';
import { splitAttachmentMentions } from '@session-chat/core/markdown/attachment-mentions';
import { blockPlainText } from '@session-chat/core/markdown/plain-text';
import type { SegmentCtx } from '@session-chat/core/units';
import { defineUnit } from '@session-chat/core/units';
import { useChatTranslator } from '@session-chat/localization';
import { pxTokens } from '@session-chat/styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { Show, createMemo } from 'solid-js';
import type { ChatMessage } from '@session-chat/model';
import {
  effectiveMessageVars,
  type MessageVars,
} from './metrics';
import { UserMessageCard } from './UserMessageCard';
import { estimateUserMessage, measureUserMessage } from './user-message-metrics';
import { DELIVERY_VARS, DeliveryCard, estimateDelivery, measureDelivery } from './DeliveryCard';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { parseHookNotice } from '@session-chat/lib/hook-notice';
import {
  HOOK_NOTICE_VARS,
  HookNoticeCard,
  estimateHookNotice,
  measureHookNotice,
} from './HookNoticeCard';
import {
  assistantOuter,
  assistantRoot,
  assistantVars,
  footerRow,
  messageText,
  srOnly,
} from './message.css';

export function normalizeMessage(item: ChatMessage): ChatMessage {
  const guguDelivery = item.guguDelivery ?? readDeliveryEnvelope(item.text);
  // 只有 agent 那一路会带 hook 通知：桥把它当助手消息发过来。用户自己打的字里出现同样的
  // 形状是他引用的原文，❌ 不能拿它当钩子说话。
  const hookNotice =
    item.hookNotice ?? (item.role === 'assistant' ? (parseHookNotice(item.text) ?? undefined) : undefined);
  const normalized = {
    ...item,
    ...(guguDelivery ? { text: guguDelivery.body, guguDelivery } : {}),
    ...(hookNotice ? { text: hookNotice.body, hookNotice } : {}),
    attachments: item.attachments?.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      ...(attachment.dataUrl ? { dataUrl: attachment.dataUrl } : {}),
    })),
  };
  // 正文里指着附件的 mention 投影到附件条上(#5269)。首轮附件只能以「正文里一条绝对路径」
  // 送达,那是**传输方式**;用户看的是「我附了这个」,两条路该长成同一个样子。只对用户消息做
  // —— 附件条本来就只长在用户卡上(measureMessage 的 `aH` 也只在那一支)。
  if (normalized.role !== 'user') return normalized;
  const split = splitAttachmentMentions(normalized.text);
  if (split.attachments.length === 0) return normalized;
  // ⚠️ 刚发出去的那一轮**两样都有**:上传那条路给的附件(带着现成的 previewUrl),以及正文里
  // 那条指向我们自己副本的引用。两个都画就是同一张图出现两次。按名字去重,**已有的那份优先**
  // —— 它手上就有字节,不必再去读盘。重启之后上传那份 replay 不回来,引用还在,于是同一张图
  // 由引用接着画:live 与重启后都恰好一张(#5269)。
  const already = new Set((normalized.attachments ?? []).map((attachment) => attachment.name));
  const projected = split.attachments.filter((attachment) => !already.has(attachment.name));
  return {
    ...normalized,
    // 正文里那枚 pill 无论如何都要摘掉:附件已经画在上面了,留着就是把传输方式摆回用户脸上。
    text: split.text,
    attachments: [...(normalized.attachments ?? []), ...projected],
  };
}

export function messageFromItem(item: ChatMessage, ctx: SegmentCtx): ChatMessage {
  return {
    ...normalizeMessage(item),
    streaming: ctx.active && item.role === 'assistant',
  };
}

// ── Measure ───────────────────────────────────────────────────────────────────

export function measureMessage(item: ChatMessage, ctx: MeasureCtx, baseVars: MessageVars): number {
  const vars = effectiveMessageVars(baseVars, ctx.theme.layout);
  const blocks = item.streaming
    ? ctx.caches.parseBlocksStreaming(item.id, item.text)
    : ctx.caches.parseBlocks(item.id, item.text);

  // Delivered inputs share the user-message body, plus a compact source line.
  if (item.role === 'user' && item.guguDelivery) {
    return measureDelivery(item, ctx, DELIVERY_VARS, baseVars);
  }

  // hook 说的话不是 agent 的回复，是一块框（#4981）。
  // (子智能体跑完的通知已经不走消息这条路了 —— 它是一行工具调用，见 item-fold 的
  //  `subagent_done` 分支。)
  if (item.hookNotice) {
    return measureHookNotice(item, ctx, HOOK_NOTICE_VARS);
  }

  if (item.role === 'user') return measureUserMessage(item, ctx, baseVars);

  // assistant / thought
  const footer = isFinalReply(item, ctx) ? vars.footerH : 0;
  if (blocks.length === 0) {
    return ctx.theme.fonts.body.lineHeight + footer;
  }
  const stack = layoutBlockStack(blocks, ctx, { isCollapsed: ctx.isCollapsed });
  return stack.height + footer;
}

/**
 * 页脚(复制按钮那一行)只给**跑完后的最后一条回复**(#4981)。
 *
 * 曾经每条助手消息都留 24px 页脚、settled 了就画复制按钮 —— 会话还在跑时,每一段都只是
 * 临时片段,读者看到的是段落之间一块块空白和半截话底下的「复制消息」(owner 2026-09-06:
 * 「这只是个临时片段,而不是最终消息啊」)。谁是最终回复由 ChatRoot 判(会话空闲 + 最后
 * 一条助手消息),这里只比对 id。
 */
function isFinalReply(item: ChatMessage, ctx: Pick<MeasureCtx, 'finalReplyId'>): boolean {
  return item.role === 'assistant' && ctx.finalReplyId != null && ctx.finalReplyId === item.id;
}

function AssistantRender(props: { data: ChatMessage; ctx: RenderCtx; vars: MessageVars }) {
  const mCtx = () => props.ctx.measureCtx?.();

  // One frontier Map per mounted instance — persists across streaming chunks
  // because the <For> in UnitRow keeps this component alive. Shared by ref with
  // StreamContext so an html block can update it after each paint without reactivity.
  //
  // `streaming` and `settledCount` are reactive accessors so Code.tsx effects
  // track the per-block settled transition (fence close or blank-line boundary)
  // and highlight each block exactly once when it crosses that boundary.
  const parsed = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return { blocks: [] as Block[], settledCount: 0 };
    const blocks = props.data.streaming
      ? ctx.caches.parseBlocksStreaming(props.data.id, props.data.text)
      : ctx.caches.parseBlocks(props.data.id, props.data.text);
    const settledCount = props.data.streaming
      ? ctx.caches.settledBlockCount(props.data.id)
      : blocks.length;
    return { blocks, settledCount };
  });

  const streamAnimation: StreamAnimation = {
    frontier: new Map(),
    streaming: () => props.data.streaming === true,
    settledCount: () => parsed().settledCount,
  };

  const stack = createMemo<Measured<StackLayout> | null>(() => {
    const ctx = mCtx();
    if (!ctx) return null;
    const blocks = parsed().blocks;
    if (blocks.length === 0) return null;
    return layoutBlockStack(blocks, ctx, { isCollapsed: ctx.isCollapsed });
  });

  const totalH = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return 0;
    return measureMessage(props.data, ctx, props.vars);
  });

  const showFooter = createMemo(() => {
    const ctx = mCtx();
    return ctx ? isFinalReply(props.data, ctx) : false;
  });

  const plainText = () => {
    const ctx = mCtx();
    if (!ctx) return props.data.text;
    // Use the same parse path as the renderer so we don't trigger a full reparse
    // during streaming just for the screen-reader text.
    const parse = props.data.streaming ? ctx.caches.parseBlocksStreaming : ctx.caches.parseBlocks;
    return parse(props.data.id, props.data.text).map(blockPlainText).join('\n\n');
  };

  const role = () =>
    (props.data.role === 'thought' ? 'thought' : 'assistant') as 'thought' | 'assistant';

  return (
    <div
      class={`${assistantOuter} ${messageText({ role: role() })} ${assistantRoot}`}
      style={assignInlineVars(assistantVars, pxTokens({ height: totalH() }))}
    >
      <div class={srOnly}>{plainText()}</div>
      <StreamContext.Provider value={props.data.streaming ? streamAnimation : null}>
        <Show when={stack()}>{(s) => <BlockStackView node={s()} />}</Show>
      </StreamContext.Provider>
      <Show when={showFooter()}>
        <div class={footerRow} style={{ height: `${props.vars.footerH}px` }}>
          <CopyButton text={props.data.text} variant="inline" labelKey="transcript.copyMessage" />
        </div>
      </Show>
    </div>
  );
}

// ── MessageUnitRender ─────────────────────────────────────────────────────────

/**
 * User-role dispatch shared by the virtualized row and the pinned overlay:
 * delivered and typed inputs share UserMessageCard; deliveries add their source metadata.
 */
export function UserMessageRender(props: { data: ChatMessage; ctx: RenderCtx; vars: MessageVars }) {
  return (
    <Show
      when={props.data.guguDelivery}
      fallback={<UserMessageCard data={props.data} ctx={props.ctx} vars={props.vars} />}
    >
      <DeliveryCard data={props.data} ctx={props.ctx} vars={DELIVERY_VARS} messageVars={props.vars} />
    </Show>
  );
}

/**
 * Role dispatch must be reactive, not a one-shot `if`: UnitRow keeps one row
 * component per *index*, and a structural change above a row (a settled turn
 * folding or unfolding, #4874; loadOlder) hands that same component a message
 * of the other role. A plain `if` evaluated at creation would keep painting an
 * assistant reply inside the user card it was born with.
 */
function MessageUnitRender(props: { data: ChatMessage; ctx: RenderCtx; vars: MessageVars }) {
  const translate = useChatTranslator();
  return (
    <Show
      when={props.data.hookNotice}
      fallback={
        <Show
          when={props.data.role === 'user'}
          fallback={<AssistantRender data={props.data} ctx={props.ctx} vars={props.vars} />}
        >
          <UserMessageRender data={props.data} ctx={props.ctx} vars={props.vars} />
        </Show>
      }
    >
      {(notice) => (
        // 与上面同一个理由：分派必须是响应式的，`Show` 而不是一次性的 `if`。
        <HookNoticeCard
          data={props.data}
          ctx={props.ctx}
          vars={HOOK_NOTICE_VARS}
          tone={notice().level}
          label={translate('transcript.hookNoticeFrom', { hook: notice().hookName })}
          srLabel={translate(`transcript.hookNoticeLevel.${notice().level}`)}
        />
      )}
    </Show>
  );
}

// ── UnitDef ───────────────────────────────────────────────────────────────────

export const messageUnitDef = defineUnit<ChatMessage, MessageVars>({
  kind: 'message',
  margin: { top: 8, bottom: 8 },
  vars: {
    cardBorder: 1,
    collapsedMaxH: 120,
    expandedMaxH: 360,
    userCardPadX: 16,
    userCardPadY: 16,
    attachThumb: 32,
    attachGap: 8,
    footerH: 24,
  },

  estimate(item, ctx, baseVars): number {
    const vars = effectiveMessageVars(baseVars, ctx.theme.layout);
    if (item.role === 'user' && item.guguDelivery) {
      return estimateDelivery(item, ctx, DELIVERY_VARS, baseVars);
    }
    if (item.hookNotice) {
      return estimateHookNotice(item, ctx, HOOK_NOTICE_VARS);
    }
    if (item.role === 'user') return estimateUserMessage(item, ctx, baseVars);
    const lines = Math.max(1, Math.ceil(item.text.length / 60));
    const footer = isFinalReply(item, ctx) ? vars.footerH : 0;
    return proseLinesHeight(lines, ctx.theme) + footer;
  },

  measure: measureMessage,

  Render: MessageUnitRender,
});
