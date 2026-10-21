import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { AcpTranscriptParser } from '@gugu/session-core/acp';
import { codexReasoningText } from '@gugu/core/shared/reasoningText.mjs';
import { describe, expect, it, vi } from 'vitest';
import { createCodexSubagents } from './codex-subagents.mjs';

function rig() {
  const updates: SessionUpdate[] = [];
  const request = vi.fn(async () => ({}));
  const controller = createCodexSubagents({ rootId: () => 'root', emit: (update: SessionUpdate) => updates.push(update),
    request, reasoningText: codexReasoningText,
    itemTool: (item: Record<string, unknown>) => item.type === 'commandExecution' ? { title: item.command, kind: 'execute' } : null,
  });
  const send = (method: string, params: Record<string, unknown>) => controller.onNotification({ method, params });
  const launch = () => send('item/completed', { threadId: 'root', item: {
    type: 'subAgentActivity', id: 'spawn-call', kind: 'started', agentThreadId: 'child', agentPath: '/root/audit',
  } });
  return { controller, updates, request, send, launch };
}

describe('native Codex child-thread consumption', () => {
  it('replays child lifecycle once from its own turns, after loading its output', async () => {
    const r = rig();
    r.controller.replayItem({ type: 'subAgentActivity', id: 'spawn', kind: 'completed', agentThreadId: 'child', agentPath: '/root/audit' });
    const parser = new AcpTranscriptParser({ sessionId: 'parent' });
    for (const update of r.updates) parser.push(update);
    expect(parser.agents[0].status).toBe('running');
    r.request.mockResolvedValue({ thread: { id: 'child', turns: [{ id: 'child-turn', status: 'completed', items: [
      { type: 'agentMessage', id: 'answer', text: 'HISTORICAL_RESULT' },
    ] }] } });
    const before = r.updates.length;
    await r.controller.replayChildren();
    for (const update of r.updates.slice(before)) parser.push(update);
    expect(parser.agents[0]).toMatchObject({ status: 'completed', output: 'HISTORICAL_RESULT', canCancel: false });
    expect(parser.activeTurn!.items.filter((item) => item.kind === 'subagent-done-tool-call')).toEqual([
      expect.objectContaining({ outputText: 'HISTORICAL_RESULT' }),
    ]);
  });

  it('routes child output, reasoning and tools into the shared subagent model, not root prose', () => {
    const r = rig(); r.launch();
    r.send('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
    r.send('item/agentMessage/delta', { threadId: 'child', itemId: 'a', delta: 'CHILD_RESULT' });
    r.send('item/reasoning/summaryTextDelta', { threadId: 'child', itemId: 'r', delta: 'CHILD_THOUGHT', summaryIndex: 0 });
    r.send('item/started', { threadId: 'child', item: { type: 'commandExecution', id: 'cmd', command: 'inspect files' } });
    r.send('item/completed', { threadId: 'child', item: { type: 'commandExecution', id: 'cmd', command: 'inspect files', status: 'completed' } });
    r.send('item/completed', { threadId: 'child', item: { type: 'agentMessage', id: 'a', text: 'CHILD_RESULT' } });
    r.send('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } });
    const parser = new AcpTranscriptParser({ sessionId: 'parent' });
    for (const update of r.updates) parser.push(update);
    const data = JSON.stringify({ history: parser.history, active: parser.activeTurn, agents: parser.agents });
    expect(data).toContain('CHILD_RESULT');
    expect(data).toContain('CHILD_THOUGHT');
    expect(parser.agents).toHaveLength(1);
    expect(parser.agents[0]).toMatchObject({ status: 'completed', output: 'CHILD_RESULT', reasoning: 'CHILD_THOUGHT' });
    const items = [...parser.history.flatMap((turn) => turn.items), ...(parser.activeTurn?.items ?? [])];
    expect(items.some((item) => item.kind === 'message')).toBe(false);
    expect(items.find((item) => item.kind === 'spawn-subagent-tool-call')).toMatchObject({ children: [expect.objectContaining({ toolCallId: 'cmd' })] });
  });

  it('uses only the known child turn for cancellation; no child can cancel the parent', async () => {
    const r = rig(); r.launch();
    await expect(r.controller.stop('root')).rejects.toThrow('no running turn');
    await expect(r.controller.stop('child')).rejects.toThrow('no running turn');
    r.send('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
    await r.controller.stop('child');
    expect(r.request).toHaveBeenCalledExactlyOnceWith('turn/interrupt', { threadId: 'child', turnId: 'child-turn' });
    r.send('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'interrupted' } });
    await expect(r.controller.stop('child')).rejects.toThrow('no running turn');
  });

  it('keeps new and legacy collaboration, nested ownership and unrelated threads separate', () => {
    const r = rig();
    expect(r.send('item/agentMessage/delta', { threadId: 'stranger', delta: 'NO' })).toBe(false);
    r.send('item/completed', { threadId: 'root', item: { type: 'collabAgentToolCall', id: 'old-call', tool: 'spawnAgent',
      senderThreadId: 'root', receiverThreadIds: ['child'], prompt: 'Audit permissions', model: 'worker-model', agentsStates: {} } });
    r.send('item/completed', { threadId: 'child', item: { type: 'subAgentActivity', id: 'nested-call', kind: 'started', agentThreadId: 'grandchild', agentPath: '/root/audit/nested' } });
    const parser = new AcpTranscriptParser({ sessionId: 'parent' });
    for (const update of r.updates) parser.push(update);
    expect(parser.agents).toHaveLength(2);
    const items = parser.activeTurn!.items;
    expect(items.filter((item) => item.kind === 'spawn-subagent-tool-call')).toHaveLength(1);
    expect(items[0]).toMatchObject({ model: 'worker-model', children: [expect.objectContaining({ toolCallId: 'grandchild' })] });
  });
});
