import { describe, expect, it, vi } from 'vitest';
import { AcpTranscriptParser } from './parser';
import { terminalEntityId, withReferencedTerminals, type TerminalState } from '../models/terminals';

const terminal = (terminalId: string, output: string): TerminalState => ({
  terminalId, owner: 'agent', canKill: false, command: 'echo', args: [], cwd: '/w',
  output, truncated: false, exitStatus: { exitCode: 0, signal: null },
});

function committed() {
  const parser = new AcpTranscriptParser({ sessionId: 'task' });
  parser.pushEvent({ kind: 'tool_update', toolCallId: 'cmd', title: 'echo', toolKind: 'execute',
    contentBlocks: [{ type: 'terminal', terminalId: 't' }], status: 'completed' }, 1);
  parser.endTurn(2);
  return parser;
}

describe('referenced terminal history', () => {
  it('keeps only actual references and revises the same committed turn when a final snapshot arrives later', () => {
    const parser = committed();
    const originalId = parser.history[0].id;
    parser.pushEvent({ kind: 'terminal_snapshots', terminals: [terminal('orphan', 'DO_NOT_STORE'), terminal('t', 'first')] });
    expect(parser.history[0]).toMatchObject({ id: originalId, terminals: [terminal('t', 'first')] });
    const same = parser.history;
    parser.pushEvent({ kind: 'terminal_snapshots', terminals: [terminal('t', 'first')] });
    expect(parser.history).toBe(same);
    parser.pushEvent({ kind: 'terminal_snapshots', terminals: [terminal('t', 'final')] });
    expect(parser.history).toHaveLength(1);
    expect(parser.activeTurn).toBeNull();
    expect(parser.history[0]).toMatchObject({ id: originalId, terminals: [terminal('t', 'final')] });
    expect(JSON.stringify(parser.history)).not.toContain('DO_NOT_STORE');
  });

  it('bounds stored UTF-8 bytes, marks truncation and never splits a codepoint', () => {
    const turn = committed().history[0];
    const saved = withReferencedTerminals(turn, [terminal('t', 'prefix🙂🙂')], 6);
    expect(saved.terminals?.[0]).toMatchObject({ output: '🙂', truncated: true, canKill: false });
    expect(new TextEncoder().encode(saved.terminals![0].output).length).toBeLessThanOrEqual(6);
    expect(saved.terminals![0].output).not.toContain('�');
    expect(terminalEntityId('a', 't')).not.toBe(terminalEntityId('b', 't'));
  });

  it('shares the budget across the turn and prioritizes the newer command tail', () => {
    const turn = committed().history[0];
    const item = turn.items[0];
    if (item.kind !== 'execute-tool-call') throw new Error('Expected command');
    const two = { ...turn, items: [...turn.items, { ...item, id: 'second', seq: 1,
      toolCallId: 'second', terminalId: 'u', contentBlocks: [{ type: 'terminal', terminalId: 'u' }] }] };
    const saved = withReferencedTerminals(two, [terminal('t', 'ABCD'), terminal('u', 'EFGH'), terminal('orphan', 'EXCLUDED')], 6);
    expect(saved.terminals?.map(t => [t.terminalId, t.output, t.truncated])).toEqual([
      ['t', 'CD', true], ['u', 'EFGH', false],
    ]);
    expect(saved.terminals!.reduce((sum, t) => sum + new TextEncoder().encode(t.output).length, 0)).toBe(6);
  });

  it('leaves turns whose referenced terminals did not change untouched, without encoding their output again (#994)', () => {
    const parser = new AcpTranscriptParser({ sessionId: 'long' });
    for (let index = 0; index < 200; index++) {
      parser.pushEvent({ kind: 'tool_update', toolCallId: `c${index}`, title: 'echo', toolKind: 'execute',
        contentBlocks: [{ type: 'terminal', terminalId: `t${index}` }], status: 'completed' }, index * 2 + 1);
      parser.endTurn(index * 2 + 2);
    }
    const terminals = Array.from({ length: 200 }, (_, index) => terminal(`t${index}`, `out ${index}`));
    parser.pushEvent({ kind: 'terminal_snapshots', terminals });
    const before = parser.history;
    expect(before).toHaveLength(200);
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
      // The runtime hands out the same object for every terminal that did not change; only the last one grew.
      parser.pushEvent({ kind: 'terminal_snapshots', terminals: [...terminals.slice(0, 199), terminal('t199', 'out 199 more')] });
      expect(parser.history.slice(0, 199).every((turn, index) => turn === before[index])).toBe(true);
      expect(parser.history[199]).not.toBe(before[199]);
      expect(parser.history[199].terminals?.[0].output).toBe('out 199 more');
      expect(encode).toHaveBeenCalledTimes(1);
    } finally {
      encode.mockRestore();
    }
  });
});
