import { describe, expect, it, vi } from 'vitest';
import { WireError } from '@gugu/session-wire';

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('./runtime-process/host', () => ({ getAcpRuntimeClient: async () => state.client }));
vi.mock('../sessions/session-deferred-messages', () => ({
  withDeferredMessagesBeforeAdmission: (_id: string, text: string, admit: (text: string) => unknown) => admit(text),
}));
import { injectEmdashPromptDetached } from './inject-prompt';

describe('the host owns completion from the moment it creates the wait RPC', () => {
  it.each(['CANCELLED', 'DISCONNECTED', 'HANDLER_ERROR'] as const)('retains %s as an observed result', async code => {
    state.client = {
      promptDetached: async () => ({ requestId: 'request-1', queued: false, declined: false }),
      waitPromptDetached: async () => { throw new WireError(code, 'request ended'); },
    };
    const sent = await injectEmdashPromptDetached('conv-1', 'work');
    expect(sent.outcome).toBe('started');
    await expect(sent.completion).resolves.toMatchObject({ success: false, error: { code, message: 'request ended' } });
  });

  it('keeps a successful completion separate from admission', async () => {
    state.client = {
      promptDetached: async () => ({ requestId: 'request-1', queued: false, declined: false }),
      waitPromptDetached: async () => ({ queued: false }),
    };
    const sent = await injectEmdashPromptDetached('conv-1', 'work');
    await expect(sent.completion).resolves.toMatchObject({ success: true });
  });
});
