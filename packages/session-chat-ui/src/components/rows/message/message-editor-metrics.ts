import type { MeasureCtx } from '@session-chat/core/define';
import { measureSoftWrap } from '@session-chat/core/measure/soft-wrap';
import { userAvailableWidth } from './metrics';

export const MESSAGE_EDITOR_PADDING = 14;
export const MESSAGE_EDITOR_GAP = 12;
export const MESSAGE_EDITOR_BUTTON_HEIGHT = 32;

/** The textarea scrolls after eight lines; DOM and virtual row use these same sizes. */
export function messageEditorMetrics(text: string, ctx: MeasureCtx) {
  const width = userAvailableWidth(ctx.width, ctx.theme.layout);
  const { font, lineHeight } = ctx.theme.fonts.body;
  const lines = measureSoftWrap(text, Math.max(1, width - 2 * MESSAGE_EDITOR_PADDING), font).visualLineCount;
  const textHeight = Math.max(2, Math.min(8, lines)) * lineHeight;
  return { textHeight, height: textHeight + 2 * MESSAGE_EDITOR_PADDING + MESSAGE_EDITOR_GAP + MESSAGE_EDITOR_BUTTON_HEIGHT };
}

export function isMessageEditing(itemId: string, ctx: Pick<MeasureCtx, 'editingMessage'>): boolean {
  return ctx.editingMessage?.itemId === itemId;
}
