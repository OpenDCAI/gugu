import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), client: { editQueuedPrompt: vi.fn(), deleteQueuedPrompt: vi.fn(), changeQueuePromptOrder: vi.fn(), steerQueuedPrompt: vi.fn(), cancelTurn: vi.fn() } }));
vi.mock('@main/core/acp/session-summary-reader', () => ({ readAcpSessionState: mocks.read }));
vi.mock('@main/core/acp/runtime-process/host', () => ({ getAcpRuntimeClient: async () => mocks.client }));
import { changeConversationQueue } from './conversation-queue';

const prompt = (id: string, origin = 'manual') => ({ id, text: id, origin, hiddenContext: 'retained context', attachments: [], files: [{ itemId: 'file', version: 1, name: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, promptText: 'file context' }], createdAt: 1, updatedAt: 1 });
beforeEach(() => {
  vi.clearAllMocks();
  for (const method of Object.values(mocks.client)) method.mockResolvedValue({ success: true });
  mocks.read.mockResolvedValue({ isGenerating: true, queuedPrompts: [prompt('a'), prompt('hidden', 'communication'), prompt('b')] });
});

it('edits the runtime entry while retaining its context, attachments and edit reservation', async () => {
  const queueEdit = { draftText: 'editing', originalDraftText: 'unsent draft' };
  await changeConversationQueue('s', { kind: 'edit', id: 'a', text: 'new words', queueEdit });
  expect(mocks.client.editQueuedPrompt).toHaveBeenCalledWith({ sessionId: 's', id: 'a', input: {
    text: 'new words', hiddenContext: 'retained context', attachments: [], files: prompt('a').files, origin: 'manual',
  }, queueEdit });
});

it('reorders the visible queue without moving hidden communication slots', async () => {
  await changeConversationQueue('s', { kind: 'reorder', ids: ['b', 'a'] });
  expect(mocks.client.changeQueuePromptOrder).toHaveBeenCalledWith({ sessionId: 's', ids: ['b', 'hidden', 'a'] });
});

it('steers through the existing runtime operation without cancelling the current turn', async () => {
  await changeConversationQueue('s', { kind: 'send-now', id: 'b', steers: true });
  expect(mocks.client.steerQueuedPrompt).toHaveBeenCalledWith({ sessionId: 's', id: 'b' });
  expect(mocks.client.cancelTurn).not.toHaveBeenCalled();
});

it('moves a non-steering prompt first and then cancels the running turn', async () => {
  await changeConversationQueue('s', { kind: 'send-now', id: 'b', steers: false });
  expect(mocks.client.changeQueuePromptOrder).toHaveBeenCalledWith({ sessionId: 's', ids: ['b', 'a', 'hidden'] });
  expect(mocks.client.cancelTurn).toHaveBeenCalledWith({ sessionId: 's' });
});

it('refuses stale, duplicate, hidden and malformed writes', async () => {
  await expect(changeConversationQueue('s', { kind: 'reorder', ids: ['a', 'a'] })).rejects.toThrow('queue changed');
  await expect(changeConversationQueue('s', { kind: 'delete', id: 'hidden' })).rejects.toThrow('no longer available');
  await expect(changeConversationQueue('s', { kind: 'delete', id: 'gone' })).rejects.toThrow('no longer available');
  await expect(changeConversationQueue('s', { kind: 'unknown', id: 'a' } as never)).rejects.toThrow('Unsupported');
  expect(mocks.client.deleteQueuedPrompt).not.toHaveBeenCalled();
});

it('propagates a runtime refusal instead of reporting a successful edit', async () => {
  mocks.client.deleteQueuedPrompt.mockResolvedValue({ success: false, error: 'runtime refused' });
  await expect(changeConversationQueue('s', { kind: 'delete', id: 'a' })).rejects.toThrow('runtime refused');
});
