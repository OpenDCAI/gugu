import { describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@gugu/session-shared/logger';
import { FakeAcpAgent, requestActivityCell } from '../acp-test-support';

function fixture() {
  const agent = new FakeAcpAgent();
  const cell = requestActivityCell(agent, { sessionId: 'assistant', projectId: 'project', providerId: 'claude',
    acpSessionId: 'native', resolveAttachment: vi.fn(), logger: noopLogger });
  cell.applySessionReady();
  cell.push({ kind: 'commands', commands: [{ name: 'compact', description: 'Compact context' }] });
  return { cell, agent };
}

describe('native idle compaction admission', () => {
  it('sends only the native command, preserving queued per-turn context and hiding the maintenance input', async () => {
    const { cell, agent } = fixture();
    cell.setTurnContext('panel', 'panel update for the next real message');
    await expect(cell.compactIfIdle()).resolves.toEqual({ success: true, data: { compacted: true } });
    expect(agent.prompt).toHaveBeenCalledWith({ sessionId: 'native', prompt: [{ type: 'text', text: '/compact' }] });
    expect(JSON.stringify(cell.history())).not.toContain('/compact');
    await cell.prompt({ text: 'hi', origin: 'communication' });
    expect(JSON.stringify(agent.prompt.mock.calls[1])).toContain('panel update for the next real message');
  });

  it('does not overlap a prompt waiting for the native running notification', async () => {
    const { cell, agent } = fixture();
    let finish!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const active = cell.prompt({ text: 'real message', origin: 'communication' });
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledOnce());
    await expect(cell.compactIfIdle()).resolves.toEqual({ success: true, data: { compacted: false } });
    finish({ stopReason: 'end_turn' });
    await active;
  });

  it('queues a new delivery behind compaction and drains it when the command finishes without an idle event', async () => {
    const { cell, agent } = fixture();
    let finish!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const compacting = cell.compactIfIdle();
    await expect(cell.queueBehindTurn({ text: 'new message', origin: 'communication' }))
      .resolves.toEqual({ success: true, data: { queued: true } });
    expect(agent.prompt).toHaveBeenCalledOnce();
    finish({ stopReason: 'end_turn' });
    await compacting;
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(agent.prompt.mock.calls[1])).toContain('new message');
    expect(JSON.stringify(cell.history())).not.toContain('/compact');
  });

  it('declines unknown commands, pending permissions, queued messages and background work', async () => {
    for (const block of ['command', 'permission', 'queue', 'background'] as const) {
      const { cell, agent } = fixture();
      if (block === 'command') cell.push({ kind: 'commands', commands: [] });
      if (block === 'queue') cell.queuePrompt({ text: 'waiting', origin: 'communication' });
      if (block === 'background') cell.machine.apply({ type: 'AgentsChanged', runningCount: 1 });
      if (block === 'permission') cell.machine.apply({ type: 'PermissionRequested', request: {
        requestId: 'p', toolCallId: 't', options: [], toolCall: { toolCallId: 't', title: 'approval' },
      } } as never);
      expect(await cell.compactIfIdle()).toMatchObject({ success: true, data: { compacted: false } });
      expect(agent.prompt).not.toHaveBeenCalled();
    }
  });

  it('unblocks subsequent real work after a native compact error without adding a fake user turn', async () => {
    const { cell, agent } = fixture();
    agent.prompt.mockRejectedValueOnce(new Error('compact failed'));
    expect((await cell.compactIfIdle()).success).toBe(false);
    await cell.prompt({ text: 'still usable', origin: 'communication' });
    expect(agent.prompt).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(cell.history())).not.toContain('/compact');
  });

  it('retains a steer-capable delivery instead of injecting it into the compaction request', async () => {
    const { cell, agent } = fixture();
    cell.setSupportsSteering(true);
    let finish!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const compacting = cell.compactIfIdle();
    const delivery = cell.promptDetached({ text: 'urgent delivery', origin: 'communication' }, { steerIfBusy: true });
    await expect(delivery.admission).resolves.toEqual({ success: true, data: { queued: true } });
    expect(agent.prompt).toHaveBeenCalledOnce();
    finish({ stopReason: 'end_turn' });
    await compacting;
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(agent.prompt.mock.calls[1])).toContain('urgent delivery');
  });
});
