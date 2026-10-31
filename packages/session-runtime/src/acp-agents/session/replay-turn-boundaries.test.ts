import { noopLogger } from '@gugu/session-shared/logger';
import { describe, expect, it } from 'vitest';
import { FakeAcpAgent } from '../acp-test-support';
import { SessionCell } from './cell';

function cell() {
  const value = new SessionCell({ sessionId: 'replay', projectId: 'project', providerId: 'claude', acpSessionId: 'provider',
    agent: new FakeAcpAgent(), logger: noopLogger, resolveAttachment: async () => ({ data: '', mimeType: 'image/png' }) });
  return value;
}

describe('replayed native turn boundaries', () => {
  it('keeps autonomous cycles separate without taking the replaying runtime into work', () => {
    const value = cell();
    value.beginReplay();
    value.push({ kind: 'message', role: 'user', messageId: 'u', text: 'Launch background tasks' });
    value.push({ kind: 'message', role: 'assistant', messageId: 'a', text: 'Launched' });
    for (const [id, text] of [['followup-1', 'First result'], ['followup-2', 'Second result']]) {
      value.push({ kind: 'agent_state', source: 'agent', state: 'idle' });
      value.push({ kind: 'agent_state', source: 'agent', state: 'running' });
      expect(value.sessionState.lifecycle).toBe('replaying');
      value.push({ kind: 'message', role: 'assistant', messageId: id, text });
    }
    value.push({ kind: 'agent_state', source: 'agent', state: 'idle' });
    value.push({ kind: 'agent_state', source: 'agent', state: 'idle' });
    value.endReplay();
    const history = value.history();
    expect(history.active).toBeNull();
    expect(history.committed.map((turn) => turn.initiator)).toEqual(['user', 'agent', 'agent']);
    expect(history.committed.map((turn) => turn.items.filter((item) => item.kind === 'message').map((item) => item.text)))
      .toEqual([['Launch background tasks', 'Launched'], ['First result'], ['Second result']]);
    expect(value.sessionState.lifecycle).toBe('ready');
    expect(value.sessionState.canCancel).toBe(false);
  });

  it('does not divide a streamed reply at requires_action or running', () => {
    const value = cell();
    value.beginReplay();
    value.push({ kind: 'message', role: 'user', messageId: 'u', text: 'Inspect' });
    value.push({ kind: 'message', role: 'assistant', messageId: 'a', text: 'First' });
    value.push({ kind: 'agent_state', source: 'agent', state: 'requires_action' });
    value.push({ kind: 'agent_state', source: 'agent', state: 'running' });
    value.push({ kind: 'message', role: 'assistant', messageId: 'a', text: ' second' });
    value.endReplay();
    expect(value.history().committed).toHaveLength(1);
    expect(value.history().committed[0].items).toContainEqual(expect.objectContaining({ role: 'assistant', text: 'First second' }));
  });
});
