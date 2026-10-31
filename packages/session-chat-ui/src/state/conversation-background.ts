import type { RenderUnit } from '@session-chat/core/units';
import type { ChatMessage } from '@session-chat/model';

/** Last block ownership, never a search through an incoming message into an earlier segment. */
export function conversationBackgroundOwner(units: readonly RenderUnit[]): string | null | undefined {
  for (let i = units.length - 1; i >= 0; i--) {
    const unit = units[i];
    if (unit.kind === 'day-separator' || unit.kind === 'session-condition' || unit.kind === 'background-tasks') continue;
    if (unit.conversationProcessOwner) return unit.conversationProcessOwner;
    if (unit.kind === 'message') {
      const message = unit.data as ChatMessage;
      if (message.role === 'assistant' && message.conversationProcess) return unit.itemId;
      if (message.role === 'assistant' && message.conversationHead) return message.conversationHead;
    }
    return null;
  }
  return undefined;
}
