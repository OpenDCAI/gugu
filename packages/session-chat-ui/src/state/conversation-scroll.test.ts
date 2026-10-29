import { describe, expect, it } from 'vitest';
import { unit, type ItemSegmenter, type RenderUnit, type SegmentCtx } from '@session-chat/core/units';
import { defaultChatTranslator } from '@session-chat/localization';
import type { ChatMessage, TranscriptTurn } from '@session-chat/model';
import { flattenTier } from './flatten';

const record: TranscriptTurn = { id: 'scroll', seq: 0, initiator: 'user', items: Array.from({ length: 10 }, (_, i) => ({
  kind: 'message', id: `say-${i}`, seq: i, role: i === 0 ? 'user' : 'assistant', text: `step ${i}`,
} as ChatMessage)) as TranscriptTurn['items'] };
const segmenters = Object.fromEntries(['day-separator', 'message', 'turn-process', 'tool-run'].map(kind => [kind, {
  kind, segment: item => [unit(item.kind, item, item, { key: 'self' })],
} satisfies ItemSegmenter]));
const context = (over: Partial<SegmentCtx> = {}): SegmentCtx => ({ caches: {}, expanded: () => false, active: true,
  foldTurnProcess: true, agentConversation: true, translate: defaultChatTranslator, plan: () => null,
  pendingToolCallIds: () => new Set(), terminalOutputText: () => null, terminalExitStatus: () => null,
  ...over,
} as SegmentCtx);

describe('live conversation process viewport', () => {
  it('retains every earlier step in one scrollable block above the latest bubble', () => {
    const rows = flattenTier([record], context(), segmenters);
    expect(rows.some(row => row.itemId.endsWith(':earlier'))).toBe(false);
    const block = rows.find(row => row.kind === 'conversation-process-steps');
    expect(block).toBeDefined();
    expect((block!.data as { units: RenderUnit[] }).units.map(row => row.itemId)).toEqual(
      Array.from({ length: 8 }, (_, i) => `say-${i + 1}`));
    expect(rows.indexOf(block!)).toBeLessThan(rows.findIndex(row => row.itemId === 'say-9'));
  });

  it('keeps search output flat and all steps reachable without an earlier-parts gate', () => {
    const rows = flattenTier([record], context({ revealAllFolds: true }), segmenters);
    expect(rows.some(row => row.itemId.endsWith(':earlier'))).toBe(false);
    expect(rows.some(row => row.kind === 'conversation-process-steps')).toBe(false);
    expect(rows.filter(row => row.folds?.some(fold => fold.id.endsWith(':earlier')))).toHaveLength(0);
    expect(rows.filter(row => /^say-/.test(row.itemId))).toHaveLength(10);
  });
});
