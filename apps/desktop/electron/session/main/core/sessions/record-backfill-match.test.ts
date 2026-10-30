import { describe, expect, it } from 'vitest';

import type { TranscriptTurn } from '@gugu/session-core/acp';
import { recordIdentityFor, recordTurnsAfterStore, turnIdentityKeys } from './record-backfill-match';

/** A turn as the runtime stored it (`S:turn:sN`) or as the record timeline reads it (`S:turn:N`). */
const turn = (id: string, prompt: string | null, own: { message?: string; tool?: string; reply?: string } = {}): TranscriptTurn => ({
  id, seq: 0, initiator: prompt === null ? 'agent' : 'user',
  items: [
    ...(prompt === null ? [] : [{ kind: 'message', id: `${id}:message:auto:user:0`, seq: 0, role: 'user', text: prompt }]),
    ...(own.message ? [{ kind: 'message', id: `${id}:message:${own.message}`, seq: 1, role: 'assistant', text: own.reply ?? 'reply' }] : []),
    ...(own.tool ? [{ kind: 'execute-tool-call', id: `${id}:tool:${own.tool}`, seq: 2, toolCallId: own.tool }] : []),
  ],
} as unknown as TranscriptTurn);

describe('filling the store from the record (#980)', () => {
  it('reads identity from ids the agent minted, not from turn numbers or synthesized segments', () => {
    expect(turnIdentityKeys(turn('S:turn:s4', 'hi', { message: 'msg_1', tool: 'call_9' })))
      .toEqual(new Set(['message:msg_1', 'tool:call_9']));
  });

  it('appends only the turns after the store, e.g. ones just run in terminal mode', () => {
    const stored = [turn('S:turn:s1', 'second', { tool: 'b' }), turn('S:turn:s0', 'first', { message: 'a' })];
    const record = [
      turn('S:turn:0', 'first', { message: 'a' }),
      turn('S:turn:1', 'second', { tool: 'b' }),
      turn('S:turn:2', 'terminal one', { tool: 'c' }),
      turn('S:turn:3', 'terminal two', { message: 'd' }),
    ];
    expect(recordTurnsAfterStore(record, stored)?.map((t) => t.id)).toEqual(['S:turn:2', 'S:turn:3']);
  });

  it('never fills a gap in the middle: older turns missing from the store stay out', () => {
    const stored = [turn('S:turn:s0', 'latest', { tool: 'z' })];
    const record = [turn('S:turn:0', 'old terminal', { tool: 'x' }), turn('S:turn:1', 'latest', { tool: 'z' })];
    expect(recordTurnsAfterStore(record, stored)).toEqual([]);
  });

  it('takes the whole record for a session whose store is empty', () => {
    const record = [turn('S:turn:0', 'a', { tool: 'x' }), turn('S:turn:1', 'b', { tool: 'y' })];
    expect(recordTurnsAfterStore(record, [])).toHaveLength(2);
  });

  it('refuses to append when the record and the store share no ids', () => {
    const stored = [turn('S:turn:s0', 'mine', { tool: 'mine' })];
    const record = [turn('S:turn:0', 'other', { tool: 'other' })];
    expect(recordTurnsAfterStore(record, stored)).toBeNull();
  });

  it('does not locate by a repeated prompt when ids exist, so an old "continue" cannot pull in history twice', () => {
    const stored = [turn('S:turn:s9', '继续', { tool: 'new' })];
    const record = [
      turn('S:turn:0', '继续', { tool: 'old' }),
      turn('S:turn:1', 'middle', { tool: 'mid' }),
      turn('S:turn:2', '继续', { tool: 'new' }),
    ];
    expect(recordTurnsAfterStore(record, stored)).toEqual([]);
  });

  it('skips a turn after the anchor that the store already has by its prompt (a turn with no ids)', () => {
    const stored = [turn('S:turn:s1', 'just talk', {}), turn('S:turn:s0', 'tool turn', { tool: 't' })];
    const record = [turn('S:turn:0', 'tool turn', { tool: 't' }), turn('S:turn:1', 'just talk', {}), turn('S:turn:2', 'new', { tool: 'n' })];
    expect(recordTurnsAfterStore(record, stored)?.map((t) => t.id)).toEqual(['S:turn:2']);
  });

  it('keeps a new turn whose prompt repeats an older stored one ("继续" with new ids)', () => {
    const stored = [turn('S:turn:s0', '继续', { tool: 't1' })];
    const record = [turn('S:turn:0', '继续', { tool: 't1' }), turn('S:turn:1', '继续', { tool: 't4' }), turn('S:turn:2', 'new', { tool: 't5' })];
    expect(recordTurnsAfterStore(record, stored)?.map((t) => t.id)).toEqual(['S:turn:1', 'S:turn:2']);
  });

  it('recognizes Codex turns by prompt and reply, because its record numbers items its own way', () => {
    expect(recordIdentityFor('codex')).toBe('content');
    expect(recordIdentityFor('claude')).toBe('ids');
    expect(recordIdentityFor('qwen')).toBeNull();
    const stored = [turn('S:turn:s0', 'ALPHA please', { message: 'msg_live', reply: 'ALPHA980' })];
    const record = [
      turn('S:turn:0', 'ALPHA please', { message: 'codex:t:1:8', reply: 'ALPHA980' }),
      turn('S:turn:1', 'BRAVO please', { message: 'codex:t:2:8', reply: 'BRAVO981' }),
    ];
    expect(recordTurnsAfterStore(record, stored, 'ids')).toBeNull();
    expect(recordTurnsAfterStore(record, stored, 'content')?.map((t) => t.id)).toEqual(['S:turn:1']);
  });

  it('does not anchor a Codex store on a prompt alone', () => {
    const stored = [turn('S:turn:s0', '继续', { message: 'msg_live', reply: 'done A' })];
    const record = [turn('S:turn:0', '继续', { message: 'codex:t:1:8', reply: 'done B' })];
    expect(recordTurnsAfterStore(record, stored, 'content')).toBeNull();
  });

  it.each(['auto:assistant:0', 'hermes-row-12'])('aligns Hermes SQLite rows with stored %s messages by prompt and final reply', (message) => {
    // Native rows use hermes:<row>#0; live text has no message id, and old ACP replay used hermes-row-<row>.
    const stored = [turn('S:turn:7', 'continue', { message, reply: 'first reply' })];
    const record = [
      turn('S:turn:0', 'continue', { message: 'hermes:12#0', reply: 'first reply' }),
      turn('S:turn:1', 'continue', { message: 'hermes:14#0', reply: 'second reply' }),
    ];
    const identity = recordIdentityFor('hermes');
    expect(identity).toBe('content');
    const storedIds = turnIdentityKeys(stored[0]);
    expect([...turnIdentityKeys(record[0])].filter((id) => storedIds.has(id))).toEqual([]);
    expect(recordTurnsAfterStore(record, stored, identity!)?.map((one) => one.id)).toEqual(['S:turn:1']);
    expect(recordTurnsAfterStore(record.slice(1), stored, identity!)).toBeNull();
  });
});
