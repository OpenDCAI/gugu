import { noopLogger } from '@gugu/session-shared/logger';
import { describe, expect, it, vi } from 'vitest';
import { FakeAcpAgent } from '../acp-test-support';
import { SessionCell } from './cell';

function harness() {
  let finishTool!: () => void;
  const tool = new Promise<void>((resolve) => { finishTool = resolve; });
  const consumed: string[] = [];
  const pendingInputs: string[] = [];
  const agent = new FakeAcpAgent();
  agent.extMethod = vi.fn(async (_method, params) => {
    pendingInputs.push((params as { prompt: { text: string }[] }).prompt[0]!.text);
    return { outcome: 'injected' };
  });
  agent.prompt = vi.fn(async () => {
    await tool;
    consumed.push(...pendingInputs);
    return { stopReason: 'end_turn' as const };
  });
  const yielded = vi.fn(finishTool);
  const cell = new SessionCell({
    sessionId: 'human-wait', projectId: 'project', providerId: 'claude', acpSessionId: 'native',
    agent, supportsSteering: true, resolveAttachment: vi.fn(), logger: noopLogger,
    callbacks: { onSessionStateChanged: () => undefined, ...{ onPromptSteered: yielded } },
  });
  cell.applySessionReady();
  return { cell, consumed, yielded, finishTool };
}

describe('human tools do not hold admitted steering behind a tool boundary', () => {
  it('consumes an admitted owner input while the human tool has not been answered', async () => {
    const h = harness();
    const turn = h.cell.prompt({ text: 'delegated work', origin: 'typed' });
    await Promise.resolve();
    h.cell.push({ kind: 'tool_call', toolKind: 'execute', parentToolCallId: null, diffs: [], locations: [],
      toolCallId: 'human-tool', title: 'app_install', status: 'in_progress' });

    await h.cell.queueBehindTurn({ text: 'answer this now', origin: 'manual' });

    await expect.poll(() => h.consumed, { timeout: 1000 }).toEqual(['answer this now']);
    expect(h.yielded).toHaveBeenCalledTimes(1);
    await turn;
  });

  it('keeps a queued owner input waiting in an owner-started turn', async () => {
    const h = harness();
    const turn = h.cell.prompt({ text: 'owner work', origin: 'manual' });
    await Promise.resolve();
    await h.cell.queueBehindTurn({ text: 'later', origin: 'manual' });
    expect(h.yielded).not.toHaveBeenCalled();
    expect(h.consumed).toEqual([]);
    h.finishTool();
    await turn;
  });
});
