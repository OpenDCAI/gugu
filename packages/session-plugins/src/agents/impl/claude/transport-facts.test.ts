import { AcpTranscriptParser } from '@gugu/session-core/acp';
import { describe, expect, it } from 'vitest';
import { decodeClaudeSessionUpdate } from './acp-transform';

describe('Claude vendor facts at ingress', () => {
  it('uses the standard tool name even when old vendor metadata disagrees', () => {
    expect(decodeClaudeSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read file',
      name: 'Read', kind: 'read', status: 'completed', _meta: { claudeCode: { toolName: 'Agent' } } }))
      .toMatchObject({ kind: 'tool_call', toolName: 'Read' });
  });

  it('does not turn old task prose or metadata into a second live lifecycle', () => {
    const parser = new AcpTranscriptParser({ sessionId: 'parent' });
    parser.pushEvent(decodeClaudeSessionUpdate({ sessionUpdate: 'subagent_update', sessionId: 'child',
      title: 'Audit', capabilities: { cancel: {} }, state: { state: 'running' } }));
    const prose = '<task-notification><task-id>child</task-id><status>completed</status><summary>OLD_TEXT</summary></task-notification>';
    const message = decodeClaudeSessionUpdate({ sessionUpdate: 'user_message', messageId: 'literal',
      content: [{ type: 'text', text: prose }], _meta: { claudeCode: { taskNotification: { taskId: 'child', status: 'completed' } } } });
    expect(message).toMatchObject({ kind: 'message', role: 'user', text: prose });
    parser.pushEvent(message);
    expect(parser.agents[0]).toMatchObject({ status: 'running' });
    parser.pushEvent(decodeClaudeSessionUpdate({ sessionUpdate: 'subagent_update', sessionId: 'child',
      state: { state: 'idle', stopReason: 'end_turn' } }));
    expect(parser.agents[0]).toMatchObject({ status: 'completed' });
  });

  it('keeps actual launch identity and background ownership across a sparse call result', () => {
    const parser = new AcpTranscriptParser({ sessionId: 'parent' });
    const raw = { sessionUpdate: 'tool_call', toolCallId: 'launch', name: 'Agent', title: 'Audit',
      kind: 'think', status: 'in_progress', rawInput: { prompt: 'FULL_REQUEST' } };
    parser.pushEvent(decodeClaudeSessionUpdate(raw));
    parser.pushEvent(decodeClaudeSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'launch', name: 'Agent',
      _meta: { claudeCode: { toolResponse: { agentId: 'native-child', isAsync: true, resolvedModel: 'native-model' } } } }));
    parser.pushEvent(decodeClaudeSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'launch', name: 'Agent', status: 'completed' }));
    expect(parser.agents).toHaveLength(1);
    expect(parser.agents[0]).toMatchObject({ agentId: 'native-child', background: true, status: 'running', model: 'native-model' });
  });
});
