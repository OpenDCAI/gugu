import { AcpTranscriptParser } from '@gugu/session-core/acp';
import { beforeEach, describe, expect, it } from 'vitest';
import { createClaudeSessionDecoder } from './acp-transform';

describe('Claude vendor facts at ingress', () => {
  let decodeClaudeSessionUpdate: ReturnType<typeof createClaudeSessionDecoder>;
  beforeEach(() => { decodeClaudeSessionUpdate = createClaudeSessionDecoder(); });
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

  it.each(['Agent', 'Task'])('keeps %s launch facts when only the first bridge frame has a name', name => {
    const parser = new AcpTranscriptParser({ sessionId: 'parent' });
    const raw = { sessionUpdate: 'tool_call', toolCallId: 'launch', name, title: 'Audit',
      kind: 'think', status: 'in_progress', rawInput: { prompt: 'FULL_REQUEST' } };
    parser.pushEvent(decodeClaudeSessionUpdate(raw));
    parser.pushEvent(decodeClaudeSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'launch', status: 'completed',
      _meta: { claudeCode: { toolResponse: { agentId: 'native-child', isAsync: true, resolvedModel: 'native-model', outputFile: '/work/child.output' } } } }));
    parser.pushEvent(decodeClaudeSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'launch', status: 'completed' }));
    expect(parser.agents).toHaveLength(1);
    expect(parser.agents[0]).toMatchObject({ agentId: 'native-child', background: true, status: 'running', model: 'native-model', outputFile: '/work/child.output' });
  });
  it.each([false, true])('does not infer a subagent from agentId in another tool result (reported=%s)', reported => {
    const parser = new AcpTranscriptParser({ sessionId: 'parent' });
    if (reported) parser.pushEvent(decodeClaudeSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'send',
      name: 'SendMessage', title: 'Send a message', kind: 'other', status: 'in_progress' }));
    const event = decodeClaudeSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'send', status: 'completed',
      _meta: { claudeCode: { toolResponse: { agentId: 'recipient', isAsync: true } } } });
    expect(event.kind).toBe('tool_update');
    parser.pushEvent(event);
    expect(parser.agents).toEqual([]);
    expect(JSON.stringify(parser.activeTurn)).not.toContain('spawn-subagent-tool-call');
  });

  it('keeps the first-report tool name scoped to its connection', () => {
    decodeClaudeSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'shared-id', name: 'Agent', title: 'Audit', kind: 'think' });
    const otherConnection = createClaudeSessionDecoder();
    expect(otherConnection({ sessionUpdate: 'tool_call_update', toolCallId: 'shared-id',
      _meta: { claudeCode: { toolResponse: { agentId: 'not-a-launch' } } } }).kind).toBe('tool_update');
  });

});
