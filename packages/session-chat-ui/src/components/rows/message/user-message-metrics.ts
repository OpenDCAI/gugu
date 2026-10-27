import { proseLinesHeight } from '@session-chat/components/rows/markdown/html/layout';
import type { MeasureCtx } from '@session-chat/core/define';
import { layoutBlockStack } from '@session-chat/core/layout/block-stack';
import type { ChatMessage } from '@session-chat/model';
import { isMessageEditing, messageEditorMetrics } from './message-editor-metrics';
import {
  attachStripHeight, effectiveMessageVars, userAvailableWidth, userInnerWidth,
  userMessageActionsHeight, type MessageVars,
} from './metrics';

/** Both typed and delivered inputs use the same measured user-message body. */
export function measureUserMessage(item: ChatMessage, ctx: MeasureCtx, baseVars: MessageVars): number {
  const vars = effectiveMessageVars(baseVars, ctx.theme.layout);
  const available = userAvailableWidth(ctx.width, ctx.theme.layout);
  const attachments = attachStripHeight(item.attachments?.length ?? 0, available, vars);
  if (!item.guguDelivery && isMessageEditing(item.id, ctx)) {
    return attachments + messageEditorMetrics(ctx.editingMessage!.text, ctx).height;
  }
  const blocks = item.streaming ? ctx.caches.parseBlocksStreaming(item.id, item.text) : ctx.caches.parseBlocks(item.id, item.text);
  const stackHeight = blocks.length === 0 ? ctx.theme.fonts.body.lineHeight
    : layoutBlockStack(blocks, { ...ctx, width: userInnerWidth(available, vars) }, { isCollapsed: ctx.isCollapsed }).height;
  const fullHeight = stackHeight + 2 * vars.userCardPadY + 2 * vars.cardBorder;
  const cap = ctx.expandedId === item.id ? vars.expandedMaxH : vars.collapsedMaxH;
  return attachments + Math.min(fullHeight, cap) + userMessageActionsHeight(vars);
}

export function estimateUserMessage(item: ChatMessage, ctx: MeasureCtx, baseVars: MessageVars): number {
  const vars = effectiveMessageVars(baseVars, ctx.theme.layout);
  const available = userAvailableWidth(ctx.width, ctx.theme.layout);
  const attachments = attachStripHeight(item.attachments?.length ?? 0, available, vars);
  if (!item.guguDelivery && isMessageEditing(item.id, ctx)) {
    return attachments + messageEditorMetrics(ctx.editingMessage!.text, ctx).height;
  }
  const lines = Math.max(1, Math.ceil(item.text.length / 60));
  const fullHeight = proseLinesHeight(lines, ctx.theme) + 2 * vars.userCardPadY + 2 * vars.cardBorder;
  const cap = ctx.expandedId === item.id ? vars.expandedMaxH : vars.collapsedMaxH;
  return attachments + Math.min(fullHeight, cap) + userMessageActionsHeight(vars);
}
