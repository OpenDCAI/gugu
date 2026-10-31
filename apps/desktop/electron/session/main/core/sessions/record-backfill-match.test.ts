import { describe, expect, it } from 'vitest';

import type { TranscriptTurn } from '@gugu/session-core/acp';
import { recordIdentityFor, recordTurnsAfterStore, turnIdentityKeys, turnPrompt } from './record-backfill-match';
import { hermesPromptMeta } from '@gugu/session-core/acp/hermes-prompt';

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
  const xmlExample = '<resource_changes>用户给出的 XML 样例，请解释它</resource_changes>';

  it('preserves user-authored XML even when it has the same tag as a host notice', () => {
    expect(turnPrompt(turn('S:turn:0', xmlExample))).toBe(xmlExample);
  });

  it('keeps a user-authored XML prompt as the backfill anchor', () => {
    const stored = [turn('S:turn:s0', xmlExample, { message: 'auto:assistant:0', reply: 'This is an XML example' })];
    const record = [turn('S:turn:0', xmlExample, { message: 'hermes:1#0', reply: 'This is an XML example' }), turn('S:turn:1', 'new terminal turn', { message: 'hermes:2#0', reply: 'new reply' })];
    expect(recordTurnsAfterStore(record, stored, 'content')).toEqual([record[1]]);
  });
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

  it.each([1, 2])('counts %i stored occurrences of an identical question and answer, rather than the final record occurrence', (count) => {
    const record = Array.from({ length: 3 }, (_, i) => turn(`S:turn:${i}`, '继续', { message: `hermes:${i}#0`, reply: '完成' }));
    const stored = Array.from({ length: count }, (_, i) => turn(`S:turn:s${i}`, '继续', { message: 'auto:assistant:0', reply: '完成' })).reverse();
    expect(recordTurnsAfterStore(record, stored, 'content')).toEqual(record.slice(count));
  });

  it.each(['prompt', 'reply'] as const)('distinguishes turns that differ only after character 300 in their %s', (field) => {
    const prefix = 'a'.repeat(350);
    const first = { prompt: 'continue', reply: 'done', [field]: `${prefix}first` };
    const second = { ...first, [field]: `${prefix}second` };
    const record = [turn('S:turn:0', first.prompt, { message: 'hermes:1#0', reply: first.reply }), turn('S:turn:1', second.prompt, { message: 'hermes:2#0', reply: second.reply })];
    const stored = [turn('S:turn:s0', first.prompt, { message: 'auto:assistant:0', reply: first.reply })];
    expect(recordTurnsAfterStore(record, stored, 'content')).toEqual([record[1]]);
  });

  it('aligns the visible tail after a unique older anchor and counts repeated newer stored turns in order', () => {
    const record = [turn('S:turn:0', 'anchor', { message: 'h0', reply: 'anchor reply' }), ...Array.from({ length: 3 }, (_, i) => turn(`S:turn:${i + 1}`, 'continue', { message: `h${i + 1}`, reply: 'done' }))];
    const stored = [turn('S:turn:s2', 'continue', { message: 'live2', reply: 'done' }), turn('S:turn:s1', 'continue', { message: 'live1', reply: 'done' }), turn('S:turn:s0', 'anchor', { message: 'live0', reply: 'anchor reply' })];
    expect(recordTurnsAfterStore(record, stored, 'content')).toEqual([record[3]]);
  });

  it('asks for older stored turns when an incomplete tail has only ambiguous repeated content', () => {
    const record = Array.from({ length: 4 }, (_, i) => turn(`S:turn:${i}`, 'continue', { message: `h${i}`, reply: 'done' }));
    const stored = Array.from({ length: 3 }, (_, i) => turn(`S:turn:s${i}`, 'continue', { message: `live${i}`, reply: 'done' })).reverse();
    expect(recordTurnsAfterStore(record, stored.slice(0, 2), 'content', { hasOlderStoredTurns: true })).toBeNull();
    expect(recordTurnsAfterStore(record, stored, 'content')).toEqual([record[3]]);
  });

  it('uses a unique anchor in a partial stored tail without requiring the entire store', () => {
    const record = [turn('S:turn:0', 'old', { message: 'h0', reply: 'old reply' }), turn('S:turn:1', 'anchor', { message: 'h1', reply: 'reply' }), turn('S:turn:2', 'new', { message: 'h2', reply: 'new reply' })];
    const stored = [turn('S:turn:s8', 'anchor', { message: 'live8', reply: 'reply' })];
    expect(recordTurnsAfterStore(record, stored, 'content', { hasOlderStoredTurns: true })).toEqual([record[2]]);
  });

  it.each(['Hello', '<gugu_delivery route="chat" msg="msg:accepted-1"><![CDATA[Hello]]></gugu_delivery>'])('matches the stored prompt after Hermes joins resource and profile notices before %s', (prompt) => {
    const native = `<resource_changes>飞书已连接</resource_changes>\n<gugu_profile_review>Review profile</gugu_profile_review>\n${prompt}`;
    const stored = [turn('S:turn:s0', prompt, { message: 'auto:assistant:0', reply: 'answer' })];
    const user = stored[0].items.find(item => item.kind === 'message' && item.role === 'user');
    if (user?.kind === 'message') user._meta = hermesPromptMeta([{ type: 'text', text: native }]);
    const record = [turn('S:turn:0', native, { message: 'hermes:1#0', reply: 'answer' }), turn('S:turn:1', 'next', { message: 'hermes:2#0', reply: 'next answer' })];
    expect(recordTurnsAfterStore(record, stored, 'content', { hermesPromptReceipts: true })).toEqual([record[1]]);
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
