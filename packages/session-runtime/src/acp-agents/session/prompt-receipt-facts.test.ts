import { describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@gugu/session-shared/logger';
import { promptInputSchema, type SessionPromptReceipt } from '@gugu/session-core/acp';
import type { AcpAgentApi } from '@gugu/session-core/agents/plugins';
import { SessionCell } from './cell';

function fixture() {
  const info = vi.fn();
  const warn = vi.fn();
  const receipts: ReturnType<typeof Promise.withResolvers<SessionPromptReceipt>>[] = [];
  const steerReceipt = Promise.withResolvers<'injected' | 'promptRequired'>();
  const prompt = vi.fn((_input: unknown, _dispatch: { requestId: string }) => {
    const receipt = Promise.withResolvers<SessionPromptReceipt>(); receipts.push(receipt); return receipt.promise;
  });
  const cell = new SessionCell({ sessionId: 'receipt-facts', projectId: 'project', providerId: 'fixture', acpSessionId: 'native',
    agent: { prompt, steer: vi.fn(() => steerReceipt.promise), cancel: vi.fn(async () => {}) } as unknown as AcpAgentApi,
    supportsSteering: true, mergeEnvelopes: texts => texts.join('\n'),
    resolveAttachment: async () => ({ data: '', mimeType: 'image/png' }), logger: { ...noopLogger, info, warn } });
  cell.applySessionReady();
  // A definite refusal rides on the existing refusal warning; every other outcome is one receipt line.
  const facts = () => [...info.mock.calls, ...warn.mock.calls].filter(([message]) => message === 'SessionCell: prompt receipt'
    || message === 'SessionCell: provider refused a prompt before admission').map(([, fields]) => fields);
  const merges = () => info.mock.calls.filter(([message]) => message === 'SessionCell: queued prompts merged').map(([, fields]) => fields);
  const accept = (index: number, text = 'first') => {
    const messageId = `native-${index}`;
    cell.push({ kind: 'message', role: 'user', messageId, text, contentMode: 'replace' });
    receipts[index]!.resolve({ status: 'accepted', requestId: prompt.mock.calls[index]![1].requestId, messageId });
  };
  const idle = () => cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' });
  return { cell, receipts, prompt, steerReceipt, facts, merges, accept, idle };
}

describe('native insertion receipts', () => {
  it('records insertion only after the matching user echo and receipt, with source and native identities', async () => {
    const p = fixture();
    try {
      const first = p.cell.promptDetached(promptInputSchema.parse({ text: 'first', clientMessageId: 'source-1' }));
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
      expect(p.facts()).toEqual([]);
      p.accept(0); await first.admission;
      expect(p.facts()).toEqual([expect.objectContaining({ clientMessageId: 'source-1',
        requestId: p.prompt.mock.calls[0]![1].requestId, receipt: { state: 'inserted', messageId: 'native-0' } })]);
      p.idle(); await first.completion;
    } finally { p.cell.dispose(); }
  });

  it('maps a merged drain back to every queued host message', async () => {
    const p = fixture();
    try {
      const first = p.cell.promptDetached({ text: 'first' });
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1)); p.accept(0); await first.admission;
      p.cell.push({ kind: 'agent_state', source: 'agent', state: 'running' });
      const queued = ['source-2', 'source-3'].map(id => p.cell.promptDetached(promptInputSchema.parse({ text: id, origin: 'communication', clientMessageId: id })));
      for (const input of queued) expect(await input.admission).toMatchObject({ success: true, data: { queued: true } });
      expect(p.facts()).toHaveLength(1);
      p.idle(); await first.completion;
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(2));
      p.accept(1, 'source-2\nsource-3');
      await vi.waitFor(() => expect(p.facts()).toHaveLength(2));
      expect(p.facts()[1]).toMatchObject({ receipt: { state: 'inserted', messageId: 'native-1' } });
      expect(p.merges()).toEqual([expect.objectContaining({ promptId: p.facts()[1]!.promptId, clientMessageIds: ['source-2', 'source-3'] })]);
      p.idle();
    } finally { p.cell.dispose(); }
  });

  it('records injected as admission with unknown native insertion, without claiming an echo', async () => {
    const p = fixture();
    try {
      const first = p.cell.promptDetached({ text: 'first' });
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1)); p.accept(0); await first.admission;
      p.cell.push({ kind: 'agent_state', source: 'agent', state: 'running' });
      const steered = p.cell.promptDetached(promptInputSchema.parse({ text: 'steer', origin: 'communication', clientMessageId: 'source-steer' }), { steerIfBusy: true });
      p.steerReceipt.resolve('injected');
      expect(await steered.admission).toMatchObject({ success: true, data: { queued: false, steered: true } });
      expect(p.facts().filter(f => f.clientMessageId === 'source-steer')).toEqual([
        expect.objectContaining({ receipt: { state: 'unknown', admission: 'injected' } }),
      ]);
      p.idle(); await first.completion;
    } finally { p.cell.dispose(); }
  });

  it('does not claim insertion for a receipt without its user echo', async () => {
    const p = fixture();
    try {
      const first = p.cell.promptDetached({ text: 'first', clientMessageId: 'source-no-echo' });
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
      p.receipts[0]!.resolve({ status: 'accepted', requestId: p.prompt.mock.calls[0]![1].requestId, messageId: 'absent-echo' });
      await first.admission; await first.completion;
      expect(p.facts()).toEqual([expect.objectContaining({ clientMessageId: 'source-no-echo', receipt: { state: 'unknown', cause: expect.objectContaining({ message: expect.stringContaining('before its user echo') }) } })]);
    } finally { p.cell.dispose(); }
  });

  it('records a v1 dispatch acknowledgement as admission with unknown native insertion', async () => {
    const p = fixture();
    try {
      const first = p.cell.promptDetached({ text: 'first', clientMessageId: 'source-v1' });
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
      p.receipts[0]!.resolve({ status: 'dispatched', requestId: p.prompt.mock.calls[0]![1].requestId });
      await first.admission;
      expect(p.facts()).toEqual([expect.objectContaining({ clientMessageId: 'source-v1', receipt: { state: 'unknown', admission: 'dispatched' } })]);
      p.idle(); await first.completion;
    } finally { p.cell.dispose(); }
  });

  it('does not turn a late receipt from a closed executor into a current insertion', async () => {
    const p = fixture();
    try {
      const first = p.cell.promptDetached({ text: 'first', clientMessageId: 'source-late' });
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
      p.cell.processClosed({ exitCode: 1, signal: null, stderrTail: '' });
      p.receipts[0]!.resolve({ status: 'accepted', requestId: p.prompt.mock.calls[0]![1].requestId, messageId: 'late' });
      await first.completion;
      await vi.waitFor(() => expect(p.facts()).toHaveLength(1));
      expect(p.facts()[0]).toMatchObject({ clientMessageId: 'source-late', receipt: { state: 'unknown', outcome: 'retired-before-receipt' } });
      expect(p.prompt).toHaveBeenCalledTimes(1);
    } finally { p.cell.dispose(); }
  });

  it.each([
    ['explicit missing session', { code: -32002, message: 'Session not found', data: { sessionId: 'native' } }, 'failed'],
    ['lost transport receipt', { code: 'prompt_admission_timeout', message: 'receipt timed out' }, 'unknown'],
  ] as const)('records %s without inserting or replaying', async (_name, error, state) => {
    const p = fixture();
    try {
      const first = p.cell.promptDetached(promptInputSchema.parse({ text: 'first', clientMessageId: 'source-failed' }));
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1)); p.receipts[0]!.reject(error);
      expect((await first.admission).success).toBe(false);
      await first.completion;
      expect(p.facts()).toEqual([expect.objectContaining({ clientMessageId: 'source-failed', receipt: { state, cause: expect.objectContaining(error) } })]);
      expect(p.prompt).toHaveBeenCalledTimes(1);
    } finally { p.cell.dispose(); }
  });
});
