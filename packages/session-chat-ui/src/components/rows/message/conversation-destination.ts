import type { ChatMessage } from '@session-chat/model';
import type { MeasureCtx } from '@session-chat/core/define';
import { agentSendLabel } from '@session-chat/state/agent-send';
import { readableLabel, rowTranslator } from '../readable-label';

export const DESTINATION_HEIGHT = 22;
export function conversationDestinationLayout(item: ChatMessage, ctx: MeasureCtx, width = ctx.width - 120) {
  if (!item.sentTo || !ctx.theme.layout.agentConversation) return null;
  const text = agentSendLabel(item.sentTo, rowTranslator(ctx), ctx.chatName ?? (() => null));
  const natural = readableLabel(text, ctx, Number.MAX_SAFE_INTEGER, 12, 18);
  return { text, width: Math.max(1, Math.min(180, width, natural.width)), height: DESTINATION_HEIGHT };
}
