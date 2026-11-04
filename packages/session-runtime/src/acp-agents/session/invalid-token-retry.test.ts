import { describe, expect, it, vi } from 'vitest';
import type { AcpAgentApi } from '@gugu/session-core/agents/plugins';
import { noopLogger } from '@gugu/session-shared/logger';
import { SessionCell } from './cell';

function fixture() {
  const prompt = vi.fn<AcpAgentApi['prompt']>(async (_request, dispatch) => {
    cell.push({ kind: 'agent_state', source: 'agent', state: 'running' });
    return { status: 'dispatched', requestId: dispatch!.requestId };
  });
  const cell = new SessionCell({
    sessionId: 'token-retry', projectId: 'probe', providerId: 'fixture', acpSessionId: 'native',
    supportsSteering: false,
    agent: { prompt, cancel: vi.fn(async () => {}) } as unknown as AcpAgentApi,
    mergeEnvelopes: texts => texts.join('\n'),
    resolveAttachment: async () => ({ data: '', mimeType: 'image/png' }), logger: noopLogger,
  });
  cell.applySessionReady();
  return { cell, prompt };
}

describe('InvalidToken retry identity', () => {
  it('preserves a newer same-key input behind a manual fence when an admitted concurrent prompt is refused', async () => {
    const { cell, prompt } = fixture();
    try {
      const foreground = cell.promptDetached({ text: 'foreground', origin: 'manual' });
      void foreground.completion.catch(() => {});
      expect(await foreground.admission).toMatchObject({ success: true, data: { queued: false } });
      const older = cell.promptDetached({ text: 'older', origin: 'communication', coalesceKey: 'same' }, { steerIfBusy: true });
      void older.completion.catch(() => {});
      expect(await older.admission).toMatchObject({ success: true, data: { queued: false, steered: true } });
      const dispatchedOlder = prompt.mock.calls[1]![1]!;

      expect(await cell.queueBehindTurn({ text: 'manual fence', origin: 'manual' })).toMatchObject({ success: true, data: { queued: true } });
      const newer = cell.promptDetached({ text: 'newer', origin: 'communication', coalesceKey: 'same' }, { steerIfBusy: true });
      void newer.completion.catch(() => {});
      expect(await newer.admission).toMatchObject({ success: true, data: { queued: true } });
      const waiting = [...cell.sessionState.queuedPrompts];
      expect(waiting.map(input => input.text)).toEqual(['manual fence', 'newer']);

      cell.push({ kind: 'prompt_result', requestId: dispatchedOlder.requestId, error: { name: 'InvalidToken', message: 'invalid token' } });

      const queue = cell.sessionState.queuedPrompts;
      // The retry stays behind the manual fence and ahead of the newer same-key input.
      expect(queue.map(input => input.text)).toEqual(['manual fence', 'older', 'newer']);
      expect([queue[0], queue[2]]).toEqual(waiting);
      expect(dispatchedOlder.message.messageId).toContain(queue[1]!.id);
      expect(queue[1]!.id).not.toBe(waiting[1]!.id);
      expect(cell.sessionState.lifecycle).toBe('working');
      expect(prompt).toHaveBeenCalledTimes(2);

      cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' });
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(3));
      expect(cell.sessionState.queuedPrompts.map(input => input.text)).toEqual(['older', 'newer']);
      cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' });
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(4));
      // Adjacent communications normally share a FIFO batch; neither input may disappear or repeat.
      const sentTexts = prompt.mock.calls.map(([request]) => request.prompt
        .filter(block => block.type === 'text').map(block => block.text).join('\n'));
      expect(sentTexts).toEqual(['foreground', 'older', 'manual fence', 'older\nnewer']);
      expect(cell.sessionState.queuedPrompts).toEqual([]);
      cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' });
      await foreground.completion;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(prompt).toHaveBeenCalledTimes(4);
      expect(cell.sessionState.lifecycle).toBe('ready');
    } finally {
      cell.dispose();
    }
  });

  it('protects a refused foreground input from later coalescing and duplicate failure events', async () => {
    const { cell, prompt } = fixture();
    try {
      const older = cell.promptDetached({ text: 'older', origin: 'communication', coalesceKey: 'same' });
      void older.completion.catch(() => {});
      await older.admission;
      await cell.queueBehindTurn({ text: 'manual fence', origin: 'manual' });
      const newer = cell.promptDetached({ text: 'newer', origin: 'communication', coalesceKey: 'same' });
      void newer.completion.catch(() => {});
      await newer.admission;
      const [fence, waiting] = cell.sessionState.queuedPrompts;
      const failure = { kind: 'prompt_result' as const, requestId: prompt.mock.calls[0]![1]!.requestId,
        error: { name: 'InvalidToken', message: 'invalid token' } };
      cell.push(failure);
      const retry = cell.sessionState.queuedPrompts[1]!;
      cell.push(failure);
      const updated = cell.promptDetached({ text: 'latest', origin: 'communication', coalesceKey: 'same' });
      void updated.completion.catch(() => {});
      await updated.admission;

      const queue = cell.sessionState.queuedPrompts;
      expect(queue.map(input => input.text)).toEqual(['manual fence', 'older', 'latest']);
      expect(queue[0]).toEqual(fence);
      expect(queue[1]).toEqual(retry);
      expect(queue[1]!.id).not.toBe(waiting!.id);
      expect(queue[2]!.id).toBe(waiting!.id);
      expect(prompt).toHaveBeenCalledTimes(1);
    } finally {
      cell.dispose();
    }
  });
});
