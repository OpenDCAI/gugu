import { describe, expect, it, vi } from 'vitest';
import type { AcpAgentApi } from '@gugu/session-core/agents/plugins';
import type { SessionPromptReceipt } from '@gugu/session-core/acp';
import { noopLogger } from '@gugu/session-shared/logger';
import { SessionCell } from './cell';

function fixture() {
  const receipts: ReturnType<typeof Promise.withResolvers<SessionPromptReceipt>>[] = [];
  const prompt = vi.fn((_request: unknown, _dispatch: { requestId: string }) => {
    const receipt = Promise.withResolvers<SessionPromptReceipt>();
    receipts.push(receipt);
    return receipt.promise;
  });
  const cell = new SessionCell({ sessionId: 'queued', projectId: 'project', providerId: 'fixture', acpSessionId: 'native',
    agent: { prompt, cancel: vi.fn(async () => {}) } as unknown as AcpAgentApi,
    resolveAttachment: async () => ({ data: '', mimeType: 'image/png' }), logger: noopLogger });
  cell.applySessionReady();
  const accept = (index: number, messageId: string, text: string) => {
    cell.push({ kind: 'message', role: 'user', messageId, text, contentMode: 'replace' });
    receipts[index]!.resolve({ status: 'accepted', requestId: prompt.mock.calls[index]![1].requestId, messageId });
  };
  const drain = async () => { for (let index = 0; index < 12; index++) await new Promise<void>(resolve => setImmediate(resolve)); };
  return { cell, prompt, accept, drain };
}

describe('ordinary queued inputs wait for foreground completion, not acceptance', () => {
  it('releases a queued input after a command reports idle directly without a running event', async () => {
    const p = fixture();
    try {
      const first = p.cell.promptDetached({ text: '/context', origin: 'manual' });
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
      expect(await p.cell.queueBehindTurn({ text: 'next', origin: 'manual' })).toMatchObject({ success: true, data: { queued: true } });
      p.accept(0, 'command', '/context');
      await first.admission;
      await p.drain();
      expect(p.prompt).toHaveBeenCalledTimes(1);
      p.cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' });
      await first.completion;
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(2), { timeout: 200 });
    } finally { p.cell.dispose(); }
  });

  it.each(['before receipt', 'after receipt'] as const)('holds input queued %s while the provider has not reported running', async order => {
    const p = fixture();
    try {
      const first = p.cell.promptDetached({ text: 'yesterday news', origin: 'manual' });
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
      let queued: Promise<unknown>;
      if (order === 'before receipt') {
        queued = p.cell.queueBehindTurn({ text: 'i premise', origin: 'manual' });
        expect(await queued).toMatchObject({ success: true, data: { queued: true } });
        p.accept(0, 'u1', 'yesterday news');
        await first.admission;
      } else {
        p.accept(0, 'u1', 'yesterday news');
        await first.admission;
        queued = p.cell.queueBehindTurn({ text: 'i premise', origin: 'manual' });
        void queued.catch(() => {});
      }
      await p.drain();
      // The accepted receipt reserves the native cycle even while lifecycle is still ready.
      expect(p.cell.sessionState.lifecycle).toBe('ready');
      expect(p.prompt, 'ordinary queued input must stay outside the provider').toHaveBeenCalledTimes(1);
      expect(p.cell.sessionState.queuedPrompts.map(one => one.text)).toEqual(['i premise']);

      p.cell.push({ kind: 'agent_state', source: 'agent', state: 'running' });
      p.cell.push({ kind: 'message', role: 'assistant', messageId: 'a1', text: 'yesterday answer' });
      await p.drain();
      expect(p.prompt).toHaveBeenCalledTimes(1);
      expect(p.cell.history().committed).toHaveLength(0);
      p.cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn', usage: { totalTokens: 42 } });
      await first.completion;
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(2));
      const firstTurn = p.cell.history().committed[0]!;
      expect(firstTurn.foreground?.usage).toEqual({ totalTokens: 42 });
      expect(firstTurn.items.filter(one => one.kind === 'message').map(one => one.text)).toEqual(['yesterday news', 'yesterday answer']);
      p.cell.push({ kind: 'agent_state', source: 'agent', state: 'running' });
      p.accept(1, 'u2', 'i premise');
      p.cell.push({ kind: 'message', role: 'assistant', messageId: 'a2', text: 'premise answer' });
      p.cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' });
      await queued;
      await p.drain();
      expect(p.cell.history().committed).toHaveLength(2);
      expect(p.cell.sessionState.queuedPrompts).toEqual([]);
    } finally { p.cell.dispose(); }
  });
});
