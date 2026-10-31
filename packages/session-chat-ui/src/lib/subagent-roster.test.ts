import { describe, expect, it } from 'vitest';
import type { ToolNode, TranscriptTurn } from '@session-chat/model';
import { collectSubagentRoster } from './subagent-roster';

function calls(children: ToolNode[]) {
  const turn: TranscriptTurn = { id: 'parent', seq: 0, initiator: 'user', startedAt: 100,
    items: [{ kind: 'spawn-subagent-tool-call', id: 'launch', seq: 0, toolCallId: 'launch',
      title: 'Local child', name: 'Local child', status: 'done', background: true, agentStatus: 'running', children }] };
  return collectSubagentRoster([turn], null, 'Helper', 500)[0].calls;
}

describe('subagent progress presentation', () => {
  it('takes the action from the real kind and preserves complete arguments and order', () => {
    const result = calls([
      { kind: 'execute-tool-call', id: 'run', toolCallId: 'run', seq: 2, parentToolCallId: 'launch',
        title: 'A readable command title', command: 'printf first\nprintf second', status: 'running' },
      { kind: 'read-tool-call', id: 'read', toolCallId: 'read', seq: 1, parentToolCallId: 'launch',
        title: 'A readable file title', path: '/a/long/real/path.ts', status: 'done' },
    ]);
    expect(result.map(({ toolCallId, category, detail, status }) => ({ toolCallId, category, detail, status }))).toEqual([
      { toolCallId: 'read', category: 'read', detail: '/a/long/real/path.ts', status: 'done' },
      { toolCallId: 'run', category: 'execute', detail: 'printf first\nprintf second', status: 'running' },
    ]);
  });

  it('does not infer a command action from an unknown tool title', () => {
    const [call] = calls([{ kind: 'unknown-tool-call', id: 'other', toolCallId: 'other', seq: 1,
      parentToolCallId: 'launch', title: 'Run a shell command', name: 'custom-tool', toolKind: null,
      status: 'done', inputSummary: 'actual tool input' }]);
    expect(call.category).toBe('tool');
    expect(call.detail).toBe('actual tool input');
  });
});
