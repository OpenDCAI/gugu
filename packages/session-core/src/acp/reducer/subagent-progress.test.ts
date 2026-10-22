import { expect, it } from 'vitest';
import { subagentUpdate } from '@gugu/core/shared/subagentUpdates.mjs';
import { AcpTranscriptParser } from './index';
import { collectSubagentRoster } from '../../../../session-chat-ui/src/lib/subagent-roster';

it('native children retain progress after the parent moves on, and a follow-up reuses their identity', () => {
  const p = new AcpTranscriptParser({ sessionId: 'parent' });
  p.push({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'first task' } });
  p.push(subagentUpdate({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'child', name: 'Audit', background: true, capabilities: { cancel: true } }));
  p.push({ sessionUpdate: 'user_message_chunk', messageId: 'u2', content: { type: 'text', text: 'second task' } });
  p.push(subagentUpdate({ sessionUpdate: 'subagent_stream', subagentSessionId: 'child', update: {
    sessionUpdate: 'tool_call', toolCallId: 'step', title: 'Inspect files', kind: 'read', status: 'completed',
  } }));
  p.push(subagentUpdate({ sessionUpdate: 'subagent_stream', subagentSessionId: 'child', update: {
    sessionUpdate: 'agent_message_chunk', messageId: 'result', content: { type: 'text', text: 'OLD_RESULT' },
  } }));
  let roster = collectSubagentRoster(p.history, p.activeTurn, 'Subagent');
  expect(roster).toHaveLength(1);
  expect(roster[0]).toMatchObject({ completedSteps: 1, canCancel: true });
  expect(p.activeTurn!.items).toHaveLength(1);
  p.push(subagentUpdate({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'completed' }));
  expect(collectSubagentRoster(p.history, p.activeTurn, 'Subagent')).toHaveLength(0);
  p.push(subagentUpdate({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'running', canCancel: true }));
  roster = collectSubagentRoster(p.history, p.activeTurn, 'Subagent');
  expect(roster).toHaveLength(1);
  expect(p.agents).toHaveLength(1);
  expect(p.agents[0].output).toBeUndefined();
});

it('associates a v2 child with the real delegation and applies late snapshots within the original turn', () => {
  const p = new AcpTranscriptParser({ sessionId: 'parent', enrich: (event) => event.kind === 'tool_call' && event.toolCallId === 'delegate' ? { ...event, toolKind: 'subagent' } : event });
  p.push({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'first task' } });
  p.push({ sessionUpdate: 'tool_call', toolCallId: 'delegate', title: 'Audit', kind: 'other', status: 'completed' });
  p.endTurn();
  p.push({ sessionUpdate: 'user_message_chunk', messageId: 'u2', content: { type: 'text', text: 'second task' } });
  p.push(subagentUpdate({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'child', launchToolCallId: 'delegate', associationOnly: true, name: 'Audit', background: true, capabilities: { cancel: true } }));
  const child = (update: Record<string, unknown>) => p.push(subagentUpdate({ sessionUpdate: 'subagent_stream', subagentSessionId: 'child', update }));
  child({ sessionUpdate: 'tool_call', toolCallId: 'step', title: 'Inspect files', kind: 'read', status: 'completed' });
  child({ sessionUpdate: 'agent_message_chunk', messageId: 'result', content: { type: 'text', text: 'partial' } });
  child({ sessionUpdate: 'agent_message_chunk', messageId: 'result', content: { type: 'text', text: 'replaced' }, _meta: { messageSnapshot: true } });
  child({ sessionUpdate: 'agent_thought_chunk', messageId: 'thought', content: { type: 'text', text: 'reasoning' } });
  child({ sessionUpdate: 'agent_message_chunk', messageId: 'tail', content: { type: 'text', text: ' tail' } });
  expect(p.agents).toHaveLength(1);
  expect(p.agents[0]).toMatchObject({ toolCallId: 'delegate', subagentSessionId: 'child', output: 'replaced tail', reasoning: 'reasoning', launchTurnId: p.history[0].id });
  expect(p.activeTurn!.items).toHaveLength(1);
  expect(p.history[0].items).toHaveLength(2);
  expect(p.history[0].items[1]).toMatchObject({ toolCallId: 'delegate', children: [expect.objectContaining({ toolCallId: 'step' })] });
  p.push(subagentUpdate({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'completed' }));
  expect(p.agents[0].status).toBe('completed');
  expect(collectSubagentRoster(p.history, p.activeTurn, 'Subagent')).toHaveLength(0);
});

it('replaces a committed v2 message in place while a newer foreground turn is open', () => {
  const p = new AcpTranscriptParser({ sessionId: 'parent' });
  p.push({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'first' } });
  p.push({ sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: 'partial' } });
  p.endTurn();
  p.push({ sessionUpdate: 'user_message_chunk', messageId: 'u2', content: { type: 'text', text: 'next' } });
  const activeId = p.activeTurn!.id;
  p.push({ sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: 'authoritative' }, _meta: { messageSnapshot: true } });
  expect(p.history[0].items.at(-1)).toMatchObject({ kind: 'message', text: 'authoritative' });
  expect(p.activeTurn).toMatchObject({ id: activeId, items: [expect.objectContaining({ kind: 'message', text: 'next' })] });
});
