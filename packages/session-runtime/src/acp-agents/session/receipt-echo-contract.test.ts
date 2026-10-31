import { describe, expect, it, vi } from 'vitest';
import type { AcpAgentApi } from '@gugu/session-core/agents/plugins';
import type { SessionPromptReceipt } from '@gugu/session-core/acp';
import { noopLogger } from '@gugu/session-shared/logger';
import { SessionCell } from './cell';

describe('accepted receipt requires an earlier native echo', () => {
  it.each(['ready', 'running', 'previous-idle'] as const)('rejects the violating provider immediately while %s', async phase => {
    const receipt = Promise.withResolvers<SessionPromptReceipt>();
    const prompt = vi.fn(() => receipt.promise);
    const logger = { ...noopLogger, error: vi.fn() };
    const cell = new SessionCell({ sessionId: 'c', projectId: 'p', providerId: 'receipt-provider-fixture', acpSessionId: 's',
      agent: { prompt, cancel: vi.fn(async () => {}) } as unknown as AcpAgentApi,
      resolveAttachment: async () => ({ data: '', mimeType: 'image/png' }), logger });
    cell.applySessionReady();
    if (phase !== 'ready') cell.push({ kind: 'agent_state', source: 'agent', state: 'running' });
    const sent = cell.promptDetached({ text: 'user input', clientMessageId: 'unaccepted' }, { steerIfBusy: true });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    if (phase === 'previous-idle') cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' });
    let result: unknown;
    void sent.completion.then(value => { result = value; });
    receipt.resolve({ status: 'accepted', requestId: 'request', messageId: 'native-missing' });
    // Promise reactions, including a contract failure, must finish without another provider frame.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(result).toMatchObject({ success: false });
    expect(JSON.stringify(result)).toContain('receipt-provider-fixture');
    expect(JSON.stringify(result)).toMatch(/receipt.*echo/i);
    expect(logger.error).toHaveBeenCalled();
    const history = cell.history();
    expect([...history.committed, ...(history.active ? [history.active] : [])].flatMap(turn => turn.items)
      .some(item => item.kind === 'message' && item._meta?.clientMessageId === 'unaccepted')).toBe(false);
    cell.push({ kind: 'message', role: 'user', messageId: 'native-missing', text: 'late echo' });
    cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' });
    expect(result).toMatchObject({ success: false });
    cell.dispose();
  });
});

describe('sender identity on the accepted user row', () => {
  it.each(['accepted', 'dispatched'] as const)('records the same clientMessageId after the %s receipt', async status => {
    const receipt = Promise.withResolvers<SessionPromptReceipt>();
    const prompt = vi.fn(() => receipt.promise);
    const cell = new SessionCell({ sessionId: 'c', projectId: 'p', providerId: 'fixture', acpSessionId: 's',
      agent: { prompt, cancel: vi.fn(async () => {}) } as unknown as AcpAgentApi,
      resolveAttachment: async () => ({ data: '', mimeType: 'image/png' }), logger: noopLogger });
    try {
      cell.applySessionReady();
      const sent = cell.promptDetached({ text: 'exact user input', clientMessageId: 'sender-input', origin: 'manual',
        attachments: [{ type: 'attachment', id: 'image', mimeType: 'image/png', name: 'image.png' }] });
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      const users = () => {
        const history = cell.history();
        return [...history.committed, ...(history.active ? [history.active] : [])].flatMap(turn =>
          turn.items.flatMap(item => item.kind === 'message' && item.role === 'user' ? [item] : []));
      };
      expect(users().every(item => item._meta?.clientMessageId === undefined)).toBe(true);
      if (status === 'accepted') {
        cell.push({ kind: 'message', role: 'user', messageId: 'native-user', text: 'exact user input', _meta: { nativeFact: 'retained' } });
        receipt.resolve({ status, requestId: 'native-request', messageId: 'native-user' });
      } else receipt.resolve({ status, requestId: 'native-request' });
      await sent.admission;
      await vi.waitFor(() => expect(users()).toEqual([expect.objectContaining({
        text: 'exact user input', _meta: expect.objectContaining({ clientMessageId: 'sender-input' }),
        attachments: [expect.objectContaining({ id: 'image', name: 'image.png' })],
      })]));
      if (status === 'accepted') expect(users()[0]._meta?.nativeFact).toBe('retained');
      cell.push({ kind: 'agent_state', source: 'agent', state: 'running' });
      cell.push({ kind: 'message', role: 'assistant', messageId: 'answer', text: 'answer' });
      cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' });
      expect(await sent.completion).toMatchObject({ success: true });
      // The normal committed JSON row is the host's existing persistence payload.
      expect(JSON.parse(JSON.stringify(cell.history())).committed.flatMap((turn: { items: unknown[] }) => turn.items))
        .toContainEqual(expect.objectContaining({ _meta: expect.objectContaining({ clientMessageId: 'sender-input' }) }));
    } finally { cell.dispose(); }
  });
});
