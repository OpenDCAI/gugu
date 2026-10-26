import { expect, it } from 'vitest';
import { subagentUpdate } from '@gugu/core/shared/subagentUpdates.mjs';
import { AcpTranscriptParser } from './index';
import { collectSubagentRoster } from '../../../../session-chat-ui/src/lib/subagent-roster';
import { finalizeItems } from './item-fold';
import type { ToolNode } from '../models/turns';

it.each(['turn end', 'next user message', 'late parent content'] as const)(
  'keeps child tools running across %s until their own result arrives',
  (boundary) => {
    const p = new AcpTranscriptParser({ sessionId: 'parent' });
    p.push({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'start child' } });
    p.push(subagentUpdate({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'child', name: 'Audit', background: true }));
    const childTool = (status: 'in_progress' | 'completed') => subagentUpdate({
      sessionUpdate: 'subagent_stream', subagentSessionId: 'child', update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'bash', status,
      },
    });
    p.push(subagentUpdate({ sessionUpdate: 'subagent_stream', subagentSessionId: 'child', update: {
      sessionUpdate: 'tool_call', toolCallId: 'bash', title: 'sleep 60', kind: 'execute', status: 'in_progress',
    } }));
    // A normal parent tool must still settle when its own turn ends.
    p.push({ sessionUpdate: 'tool_call', toolCallId: 'parent-read', title: 'Read file', kind: 'read', status: 'in_progress' });
    if (boundary === 'next user message') {
      p.push({ sessionUpdate: 'user_message_chunk', messageId: 'u2', content: { type: 'text', text: 'next task' } });
    } else {
      p.endTurn(100);
      if (boundary === 'late parent content') {
        p.pushTail({ kind: 'message', role: 'assistant', messageId: 'tail', text: 'parent finished' }, 101);
      }
    }
    const roster = () => collectSubagentRoster(p.history, p.activeTurn, 'Subagent');
    expect(p.history[0].items.find((item) => item.kind === 'read-tool-call')).toMatchObject({ status: 'done' });
    expect(p.history[0].items.find((item) => item.kind === 'spawn-subagent-tool-call')).toMatchObject({ status: 'done' });
    expect(roster()[0]).toMatchObject({ completedSteps: 0, calls: [{ toolCallId: 'bash', status: 'running' }] });
    p.push(childTool('completed'));
    expect(roster()[0]).toMatchObject({ completedSteps: 1, calls: [{ toolCallId: 'bash', status: 'done' }] });
  }
);

it('preserves grouped, nested and finished child calls while settling parent groups', () => {
  const call = (toolCallId: string, status: 'running' | 'done' | 'error'): ToolNode => ({
    kind: 'read-tool-call', id: toolCallId, seq: 0, toolCallId, title: toolCallId, status,
  });
  const children: ToolNode[] = [{
    kind: 'tool-group', id: 'child-reads', seq: 0, label: 'Child reads', groupKind: 'read-batch', status: 'running',
    children: [call('running-read', 'running'), call('finished-read', 'done'), call('failed-read', 'error')],
  }, {
    kind: 'spawn-subagent-tool-call', id: 'nested-child', seq: 1, toolCallId: 'nested-child',
    title: 'Nested child', name: 'Nested child', status: 'done', children: [call('nested-read', 'running')],
  }];
  const settled = finalizeItems([{
    kind: 'spawn-subagent-tool-call', id: 'launch', seq: 0, toolCallId: 'launch',
    title: 'Launch', name: 'Launch', status: 'running', children,
  }, {
    kind: 'tool-group', id: 'parent-reads', seq: 1, label: 'Parent reads', groupKind: 'read-batch', status: 'running',
    children: [call('parent-read', 'running')],
  }], 100);
  expect(settled[0]).toMatchObject({ status: 'done', children });
  expect('children' in settled[0] && settled[0].children).toBe(children);
  expect(settled[1]).toMatchObject({ status: 'done', children: [{ status: 'done' }] });
});

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
