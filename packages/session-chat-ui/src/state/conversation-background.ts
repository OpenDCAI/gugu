import type { RenderUnit } from '@session-chat/core/units';
import type { ChatMessage, TurnProcessItem } from '@session-chat/model';

/** Last block ownership, never a search through an incoming message into an earlier segment. */
export function conversationBackgroundOwner(units: readonly RenderUnit[]): string | null | undefined {
  for (let i = units.length - 1; i >= 0; i--) {
    const unit = units[i];
    if (unit.kind === 'day-separator' || unit.kind === 'session-condition' || unit.kind === 'background-tasks') continue;
    // The completed silent turn still owns its inline copy, not the roster.
    // Preserve the standalone roster that previously followed its completion row.
    if (unit.kind === 'turn-process' && (unit.data as TurnProcessItem).silentCopyText !== undefined) return null;
    if (unit.conversationProcessOwner) {
      const owner = units.findLast(candidate => candidate.itemId === unit.conversationProcessOwner);
      if (owner?.kind === 'turn-process' && (owner.data as TurnProcessItem).silentCopyText !== undefined) return null;
      return unit.conversationProcessOwner;
    }
    if (unit.kind === 'message') {
      const message = unit.data as ChatMessage;
      if (message.role === 'assistant' && message.conversationProcess) return unit.itemId;
      if (message.role === 'assistant' && message.conversationHead) return message.conversationHead;
    }
    return null;
  }
  return undefined;
}
