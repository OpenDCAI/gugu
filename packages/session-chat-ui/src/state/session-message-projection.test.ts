import { describe, expect, it } from 'vitest';
import { unit } from '@session-chat/core/units';
import type { ItemSegmenter, SegmentCtx, SegmentItem } from '@session-chat/core/units';
import { defaultChatTranslator } from '@session-chat/localization';
import type { AgentSendItem, ChatMessage, TranscriptItem, TranscriptTurn } from '@session-chat/model';
import { flattenTier } from './flatten';
import { withSentReplies } from './sent-replies';

const ids = ['6417511d-8f36-4cbc-8cbb-81ce9f97df73', '7417511d-8f36-4cbc-8cbb-81ce9f97df73'];
const text = 'Delegated progress';
const segmenters = new Proxy({} as Record<string, ItemSegmenter>, {
  get: (_target, kind: string) => ({ kind, segment: (item: SegmentItem) => [unit(item.kind, item, item, { key: 'self' })] }),
});
const command = (id: string, seq: number): TranscriptItem => ({
  kind: 'execute-tool-call', id, seq, toolCallId: id, title: 'pwd', command: 'pwd', status: 'done',
});

// Claude's real MCP record has a JSON-encoded content array in rawOutput, and the extracted JSON in outputText.
// Keep both: omitting rawOutput bypasses the provider format that originally hid the sent bubble.
function relay(count: number, failed: boolean): TranscriptItem {
  const recipients = ids.slice(0, count).map((id, index) => ({
    to: `session:recipient-${index}`, status: 'queued', message_id: `msg:${id}`,
  }));
  const outputText = failed ? 'Recipient not found' : JSON.stringify({ route: 'session-direct', recipients });
  return {
    kind: 'mcp-tool-call', id: 'relay', seq: 2, toolCallId: 'toolu_relay',
    title: 'mcp__plugin_gugu-product_gugu__session_message', tool: 'session_message', server: 'plugin_gugu-product_gugu',
    status: failed ? 'error' : 'done', at: 2000, completedAt: 3000,
    rawInput: JSON.stringify({ to: recipients.map(recipient => recipient.to), text, then: 'continue' }),
    rawOutput: JSON.stringify([{ type: 'text', text: outputText }]), outputText,
  };
}

for (const active of [true, false]) for (const agentConversation of [true, false]) {
  describe(`session_message real projection: active=${active}, conversation=${agentConversation}`, () => {
    it.each([['one recipient', 1, false], ['multiple recipients', 2, false], ['failed send', 1, true]] as const)(
      '%s stays correctly classified between commands', (_name, count, failed) => {
        const turn: TranscriptTurn = {
          id: 'turn', seq: 1, initiator: 'agent', startedAt: 1000,
          ...(!active ? { endedAt: 5000, outcome: { kind: 'done' as const, reason: 'end_turn' as const } } : {}),
          items: [command('before', 1), relay(count, failed), command('after', 3)],
        };
        const ctx = {
          caches: {}, expanded: () => true, active, agentConversation, plan: () => null,
          translate: defaultChatTranslator, pendingToolCallIds: () => new Set<string>(), terminalSnapshot: () => null,
          foldTurnProcess: false, revealAllFolds: true,
        } as unknown as SegmentCtx;
        const units = flattenTier([turn], ctx, segmenters);
        const words = units.filter(unit => unit.kind === (agentConversation ? 'message' : 'agent-send'))
          .map(unit => agentConversation ? (unit.data as ChatMessage).text : (unit.data as AgentSendItem).send.text);
        expect(words.filter(word => word === text)).toHaveLength(failed ? 0 : 1);
        const projected = withSentReplies(turn, { allDestinations: true });
        const bubbles = projected.items.filter(item => item.kind === 'message' && item.role === 'assistant');
        expect(bubbles).toHaveLength(failed ? 0 : 1);
        if (!failed) expect(bubbles[0]).toMatchObject({ sentTo: { kind: 'session', count } });
        expect(withSentReplies(projected, { allDestinations: true }).items).toEqual(projected.items);
        if (failed) expect(units.some(unit => unit.kind === 'tool-run')).toBe(true);
      },
    );
  });
}
