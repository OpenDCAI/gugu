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
    const sent = cell.promptDetached({ text: 'user input' }, { steerIfBusy: true });
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
    cell.push({ kind: 'message', role: 'user', messageId: 'native-missing', text: 'late echo' });
    cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' });
    expect(result).toMatchObject({ success: false });
    cell.dispose();
  });
});
