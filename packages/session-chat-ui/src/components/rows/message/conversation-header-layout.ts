import type { ChatMessage } from '@session-chat/model';
import type { MeasureCtx } from '@session-chat/core/define';
import { conversationSpeaker } from '@session-chat/state/conversation-density';
import { readableLabel } from '../readable-label';
import { processButtonLayout, processRowHeight, backgroundPillLayout } from './process-row-layout';

const speaker = (key: string | undefined, ctx: MeasureCtx) => key === '$owner' && ctx.selfIdentity?.userId ? `user:${ctx.selfIdentity.userId}` : key;
export function conversationShowsName(item: ChatMessage, ctx: MeasureCtx): boolean {
  const current = speaker(conversationSpeaker(item), ctx), previous = speaker(item.conversationPreviousSpeaker, ctx);
  return !current || !previous || current !== previous || Boolean(item.conversationReply && !item.conversationReplyAdjacent);
}

/** Hover only changes paint. The inline metadata has the same measured geometry at rest. */
export function conversationHeaderLayout(item: ChatMessage, ctx: MeasureCtx, senderName: string) {
  const showName = conversationShowsName(item, ctx);
  const quote = Boolean(item.conversationReply);
  const process = item.role === 'assistant' ? item.conversationProcess : undefined;
  const nameBudget = Math.max(1, process ? ctx.width * .45 : ctx.width - (quote ? 30 : 0));
  const name = showName ? readableLabel(senderName, ctx, nameBudget, 12, 18, 650) : null;
  const nameWidth = name ? Math.min(nameBudget, name.width) : 0;
  const processCtx = { ...ctx, width: Math.max(40, ctx.width - nameWidth - (name ? 8 : 0) - (quote ? 30 : 0)) };
  const button = process && processButtonLayout(process, processCtx);
  const background = process && backgroundPillLayout(item.id, processCtx);
  const processWidth = button ? Math.min(processCtx.width, button.width + (background ? background.width + 19 : 0)) : 0;
  const processHeight = process ? processRowHeight(item.id, process, processCtx) : 0;
  const fixedWidth = nameWidth + processWidth + (name && process ? 8 : 0);
  return { name, nameWidth, processCtx, processWidth,
    quoteWidth: Math.max(14, Math.min(ctx.width * .55, ctx.width - fixedWidth - (fixedWidth ? 25 : 0))),
    height: name || process || quote ? Math.max(name?.height ?? 0, processHeight, quote ? 18 : 0) + 6 : 0 };
}
