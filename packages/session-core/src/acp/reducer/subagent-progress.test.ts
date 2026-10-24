import { decodeSessionUpdate } from '@gugu/session-core/acp';
import { expect, it } from 'vitest';

import { AcpTranscriptParser } from './index';
import { collectSubagentRoster } from '../../../../session-chat-ui/src/lib/subagent-roster';

it('native children retain progress after the parent moves on, and a follow-up reuses their identity', () => {
  const p = new AcpTranscriptParser({ sessionId: 'parent' });
  p.pushEvent(decodeSessionUpdate({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'first task' } }));
  p.pushEvent(decodeSessionUpdate({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'child', name: 'Audit', background: true, capabilities: { cancel: true } }));
  p.pushEvent(decodeSessionUpdate({ sessionUpdate: 'user_message_chunk', messageId: 'u2', content: { type: 'text', text: 'second task' } }));
  p.pushEvent(decodeSessionUpdate({ sessionUpdate: 'subagent_stream', subagentSessionId: 'child', update: {
    sessionUpdate: 'tool_call', toolCallId: 'step', title: 'Inspect files', kind: 'read', status: 'completed',
  } }));
  p.pushEvent(decodeSessionUpdate({ sessionUpdate: 'subagent_stream', subagentSessionId: 'child', update: {
    sessionUpdate: 'agent_message_chunk', messageId: 'result', content: { type: 'text', text: 'OLD_RESULT' },
  } }));
  let roster = collectSubagentRoster(p.history, p.activeTurn, 'Subagent');
  expect(roster).toHaveLength(1);
  expect(roster[0]).toMatchObject({ completedSteps: 1, canCancel: true });
  expect(p.activeTurn!.items).toHaveLength(1);
  p.pushEvent(decodeSessionUpdate({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'completed' }));
  expect(collectSubagentRoster(p.history, p.activeTurn, 'Subagent')).toHaveLength(0);
  p.pushEvent(decodeSessionUpdate({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'running', canCancel: true }));
  roster = collectSubagentRoster(p.history, p.activeTurn, 'Subagent');
  expect(roster).toHaveLength(1);
  expect(p.agents).toHaveLength(1);
  expect(p.agents[0].output).toBeUndefined();
});
