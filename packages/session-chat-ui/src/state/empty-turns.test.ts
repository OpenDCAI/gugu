import { describe, expect, it } from 'vitest';
import { unit, type ItemSegmenter, type SegmentCtx } from '@session-chat/core/units';
import { defaultChatTranslator } from '@session-chat/localization';
import type { ChatItem, ChatMessage, TranscriptTurn } from '@session-chat/model';
import { flattenTier } from './flatten';

const message = (id: string, role: 'user' | 'assistant', text = id): ChatMessage => ({ kind: 'message', id, seq: 0, role, text });
const turn = (id: string, items: ChatItem[] = [], outcome: TranscriptTurn['outcome'] = { kind: 'done' }): TranscriptTurn => ({
  id, seq: 0, initiator: 'agent', startedAt: 1000, endedAt: 4000, outcome, items: items as TranscriptTurn['items'],
});
const segmenters = Object.fromEntries(['day-separator', 'message', 'turn-process', 'turn-outcome', 'execute-tool-call', 'session-notice', 'thinking'].map(kind => [kind, {
  kind, segment: item => [unit(item.kind, item, item, { key: 'self' })],
} satisfies ItemSegmenter]));
const context = (extra: Partial<SegmentCtx> & { latestTurnId?: string } = {}): SegmentCtx => ({ caches: {}, expanded: () => false, active: false,
  foldTurnProcess: true, agentConversation: true, translate: defaultChatTranslator, plan: () => null,
  pendingToolCallIds: () => new Set(), terminalOutputText: () => null, terminalExitStatus: () => null,
  ...extra,
} as unknown as SegmentCtx);
const rows = (turns: TranscriptTurn[], extra: Parameters<typeof context>[0] = {}) => flattenTier(turns, context(extra), segmenters);
const processIds = (turns: TranscriptTurn[], extra: Parameters<typeof context>[0] = {}) => rows(turns, extra)
  .filter(row => row.kind === 'turn-process').map(row => row.itemId);

describe('empty agent turn visibility', () => {
  it('keeps the last empty turn as acknowledgement, then removes only its agent output once a later turn exists', () => {
    const empty = turn('empty', [message('input', 'user', 'Please check this'), message('silent', 'assistant', '[NO_REPLY]')]);
    expect(processIds([empty])).toEqual(['empty:process']);
    const next = turn('next');
    expect(processIds([empty, next])).toEqual(['next:process']);
    expect(rows([empty, next]).some(row => row.itemId === 'input')).toBe(true);
    expect(empty.items).toHaveLength(2);
  });

  it('hides a committed empty turn when the newer turn is in the active tier', () => {
    expect(processIds([turn('old')], { latestTurnId: 'new' })).toEqual([]);
    expect(processIds([turn('new')], { active: true, latestTurnId: 'new' })).toEqual(['new:process']);
  });

  it('treats whitespace, silence markers and thinking without a reply or tool as empty history', () => {
    const empty = turn('empty', [message('space', 'assistant', '  '), message('silent', 'assistant', '[NO_REPLY]'),
      { kind: 'thinking', id: 'thought', seq: 1, text: 'Reasoning', status: 'done' } as ChatItem]);
    expect(processIds([empty, turn('latest')])).toEqual(['latest:process']);
  });

  it.each(['error', 'cancelled'] as const)('keeps a historical %s turn even without output', kind => {
    const protectedTurn = turn('protected', [], { kind });
    expect(rows([protectedTurn, turn('latest')]).some(row => row.itemId === 'protected:outcome')).toBe(true);
  });

  it('keeps historical turns with a tool call, reply or attachment card', () => {
    const tool = turn('tool', [{ kind: 'execute-tool-call', id: 'call', toolCallId: 'call', seq: 0, title: 'pwd', status: 'done' } as ChatItem]);
    const reply = turn('reply', [message('answer', 'assistant')]);
    const card = turn('card', [{ ...message('attachment', 'assistant', ''), attachments: [{ id: 'file', name: 'result.png', mimeType: 'image/png' }] } as unknown as ChatMessage]);
    const out = rows([tool, reply, card, turn('latest')]);
    expect(out.some(row => row.itemId.startsWith('tool:process'))).toBe(true);
    expect(out.some(row => row.itemId === 'answer')).toBe(true);
    expect(out.some(row => row.itemId.startsWith('card:process'))).toBe(true);
  });

  it('keeps the latest empty turn in the standard session layout too', () => {
    expect(processIds([turn('latest')], { agentConversation: false })).toEqual(['latest:process']);
  });
});
