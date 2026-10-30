import { measureNaturalWidth, prepareWithSegments } from '@chenglou/pretext';
import { buildChatTheme } from '@session-chat/core/config';
import type { MeasureCtx } from '@session-chat/core/define';
import { conversationNarrationText } from './conversation-body';

export function conversationTextTheme(ctx: MeasureCtx, size = 14) {
  const config = ctx.theme.config;
  return buildChatTheme({ ...config, roles: { ...config.roles, body: { ...config.roles.body, size, lineHeight: size === 14 ? 20 : 18 } } }, ctx.theme.layout);
}

export function conversationTextWidth(text: string, ctx: MeasureCtx, size = 14): number {
  return measureNaturalWidth(prepareWithSegments(text.replace(/\s+/g, ' '), conversationTextTheme(ctx, size).fonts.body.font, { whiteSpace: 'pre-wrap' }));
}

/** The same width contract gates both the disclosure control and its measured body. */
export function conversationTextOverflow(text: string, ctx: MeasureCtx, width: number, size = 14): boolean {
  return !!text.trim() && conversationTextWidth(text, ctx, size) > Math.max(0, width);
}

export function narrationCanExpand(text: string, ctx: MeasureCtx): boolean {
  return conversationNarrationText(text) !== text.replace(/\s+/g, ' ')
    || conversationTextOverflow(text, ctx, ctx.width - 20);
}
