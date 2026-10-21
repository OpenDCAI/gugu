// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { observable, runInAction } from 'mobx';
import type { PromptInput, QueuedPrompt, QueuedPromptEdit } from '@gugu/session-core/acp';
import { translateSessionMessage } from '@renderer/localization/locale-store';

vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({}),
}));
const toasts: Array<{ title: string }> = [];
vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: (arg: { title: string }) => {
    toasts.push(arg);
  },
}));

// 桥必须在模块图加载之前就位 —— 理由见 acp-chat-store.session-absent.test.ts 抬头。
Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { load: vi.fn().mockResolvedValue([]) },
});
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    invoke: () => Promise.resolve([]),
    eventSend: () => {},
    eventOn: () => () => {},
    getPathForFile: () => '',
  },
});
const { AcpChatStore } = await import('./acp-chat-store');


let seq = 0;
function makeStore(fail = false) {
  const store = new AcpChatStore(`queue-edit-7324-${++seq}`, 'project');
  const state = observable.box({ lifecycle: 'working', pendingPermissions: [], activeTurnId: 'active',
    queuedPrompts: [{ id: 'q', text: 'original queued', origin: 'manual', createdAt: 1, updatedAt: 1,
      hiddenContext: 'context', attachments: [{ type: 'attachment', id: 'image', mimeType: 'image/png' }] }] as QueuedPrompt[] });
  const session = {
    sessionState: { current: () => state.get() },
    editQueuedPrompt: vi.fn(async (id: string, input: PromptInput, queueEdit?: QueuedPromptEdit | null) => {
      if (fail) return { success: false as const, error: new Error('save refused') };
      runInAction(() => state.set({ ...state.get(), queuedPrompts: state.get().queuedPrompts.map((entry) => {
        if (entry.id !== id) return entry;
        const { queueEdit: previous, ...rest } = entry;
        const next = queueEdit === undefined ? previous : queueEdit;
        return { ...rest, ...input, ...(next ? { queueEdit: next } : {}) };
      }) }));
      return { success: true as const, data: undefined };
    }),
  };
  runInAction(() => { store.session = session as never; store.draftText = 'my original draft'; });
  return { store, session, state };
}
beforeEach(() => { toasts.length = 0; });

describe('queued edit in the main composer (#7324)', () => {
  it('reserves the real ID and keeps original draft, attachment and hidden context', async () => {
    const { store, session } = makeStore();
    await store.beginQueuedPromptEdit('q');
    expect(session.editQueuedPrompt).toHaveBeenCalledExactlyOnceWith('q', expect.objectContaining({ text: 'original queued', hiddenContext: 'context', attachments: [{ type: 'attachment', id: 'image', mimeType: 'image/png' }] }),
      { draftText: 'original queued', originalDraftText: 'my original draft' });
    expect(store.queuedPromptEdit).toMatchObject({ id: 'q', text: 'original queued', pending: false });
    expect(store.draftText).toBe('my original draft');
    expect(toasts).toEqual([]);
  });

  it('saves the raw text to the reserved slot without overwriting the ordinary draft', async () => {
    const { store, session } = makeStore(); await store.beginQueuedPromptEdit('q');
    store.changeQueuedPromptEdit('  saved\ntext  ');
    expect(store.queuedPromptEdit?.text).toBe('  saved\ntext  ');
    await store.finishQueuedPromptEdit('  saved\ntext  ');
    expect(session.editQueuedPrompt).toHaveBeenLastCalledWith('q', expect.objectContaining({ text: '  saved\ntext  ' }), null);
    expect(store.queuedPromptEdit).toBeNull(); expect(store.draftText).toBe('my original draft');
    expect(store.queuedPrompts[0]).toMatchObject({ id: 'q', text: '  saved\ntext  ' });
  });

  it('cancels without committing the edit, including its pending debounce', async () => {
    const { store, session } = makeStore(); await store.beginQueuedPromptEdit('q');
    store.changeQueuedPromptEdit('cancel me'); await store.finishQueuedPromptEdit(null);
    expect(session.editQueuedPrompt).toHaveBeenLastCalledWith('q', expect.objectContaining({ text: 'original queued' }), null);
    expect(session.editQueuedPrompt).toHaveBeenCalledTimes(2);
    expect(store.queuedPromptEdit).toBeNull(); expect(store.draftText).toBe('my original draft');
  });

  it('keeps the editor and its text when saving fails', async () => {
    const { store, session } = makeStore(); await store.beginQueuedPromptEdit('q');
    store.changeQueuedPromptEdit('keep this edit');
    session.editQueuedPrompt.mockResolvedValueOnce({ success: false, error: new Error('save refused') });
    await store.finishQueuedPromptEdit('keep this edit');
    expect(store.queuedPromptEdit).toMatchObject({ text: 'keep this edit', pending: false });
    expect(store.draftText).toBe('my original draft');
    expect(toasts.map((t) => t.title)).toEqual([translateSessionMessage('acpFailure.editQueued')]);
  });

  it('does not start an editor for a rejected reservation', async () => {
    const { store } = makeStore(true); await store.beginQueuedPromptEdit('q');
    expect(store.queuedPromptEdit).toBeNull(); expect(store.queueEditPending).toBe(false);
    expect(store.draftText).toBe('my original draft');
    expect(toasts.map((t) => t.title)).toEqual([translateSessionMessage('acpFailure.editQueued')]);
  });
});
