import type { ChatMessage } from '@session-chat/model';
import type { MeasureCtx } from '@session-chat/core/define';
import { conversationSpeaker, messageReplyReference } from '@session-chat/state/conversation-density';
import { readableLabel } from '../readable-label';
import { processButtonLayout, processRowHeight, backgroundPillLayout } from './process-row-layout';

const speaker = (key: string | undefined, ctx: MeasureCtx) => key === '$owner' && ctx.selfIdentity?.userId ? `user:${ctx.selfIdentity.userId}` : key;
export function conversationShowsName(item: ChatMessage, ctx: MeasureCtx): boolean {
  const current = speaker(conversationSpeaker(item), ctx), previous = speaker(item.conversationPreviousSpeaker, ctx);
  return !current || !previous || current !== previous;
}

/** Hover only changes paint. The inline metadata has the same measured geometry at rest. */
export function conversationHeaderLayout(item: ChatMessage, ctx: MeasureCtx, senderName: string) {
  const showName = conversationShowsName(item, ctx);
  const quote = Boolean(messageReplyReference(item));
  const process = item.role === 'assistant' ? item.conversationProcess : undefined;
  const separator = quote && process;
  const metadataWidth = (quote ? 18 : 0) + (separator ? 4 : 0);
  // Reserve the full process row, including its background controls, before the name.
  const naturalCtx = { ...ctx, width: Number.MAX_SAFE_INTEGER };
  const naturalButton = process && processButtonLayout(process, naturalCtx);
  const naturalBackground = process && backgroundPillLayout(item.id, naturalCtx);
  const naturalProcess = naturalButton ? naturalButton.width + (naturalBackground ? naturalBackground.width + 19 : 0) : 0;
  const slots = Number(showName) + Number(quote) + Number(Boolean(process)) + Number(Boolean(separator));
  const namePrefix = showName ? readableLabel(`${Array.from(senderName)[0] ?? ''}…`, ctx, Number.MAX_SAFE_INTEGER, 12, 18, 650).width : 0;
  const gap = slots > 1 ? Math.min(8, Math.max(0, (ctx.width - naturalProcess - metadataWidth - namePrefix) / (slots - 1))) : 8;
  const namedGap = Math.max(0, slots - 1) * gap;
  const nameBudget = Math.max(0, ctx.width - naturalProcess - metadataWidth - namedGap);
  const name = showName && nameBudget > 0 ? readableLabel(senderName, ctx, Number.MAX_SAFE_INTEGER, 12, 18, 650) : null;
  const nameWidth = name ? Math.min(nameBudget, name.width) : 0;
  const referenceInFooter = quote && !name && !process;
  const gapWidth = Math.max(0, Number(Boolean(name)) + Number(quote) + Number(Boolean(process)) + Number(Boolean(separator)) - 1) * gap;
  const processCtx = { ...ctx, width: Math.max(40, ctx.width - nameWidth - metadataWidth - gapWidth) };
  const button = process && processButtonLayout(process, processCtx);
  const background = process && backgroundPillLayout(item.id, processCtx);
  const processWidth = button ? Math.min(processCtx.width, button.width + (background ? background.width + 19 : 0)) : 0;
  const processHeight = process ? processRowHeight(item.id, process, processCtx) : 0;
  return { name, nameWidth, gap, processCtx, processWidth, referenceInFooter,
    height: name || process ? Math.max(name?.height ?? 0, processHeight, quote ? 18 : 0) + 6 : 0 };
}
