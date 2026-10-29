// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInAction } from 'mobx';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import type { TranscriptTurn } from '@gugu/session-core/acp';

const boundary = vi.hoisted(() => ({
  records: new Map<string, { id: string; providerId: string; providerSessionId: string; providerSessionState?: 'missing' }>(),
  start: vi.fn(), queue: vi.fn(), draft: vi.fn(),
  liveDraft: null as { rev: number; text: string; updatedAt: number } | null,
  engineRev: 0,
  draftListeners: new Set<(draft: unknown) => void>(),
  toasts: [] as Array<{ description?: string }>,
}));
vi.mock('../stores/session-registry', () => ({
  sessionRegistry: { get: (id: string) => boundary.records.has(id)
    ? { sessions: new Map([[id, { data: boundary.records.get(id) }]]) } : undefined },
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: (value: { description?: string }) => boundary.toasts.push(value),
}));
vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({
    startSession: boundary.start, queuePrompt: boundary.queue, setPromptDraft: boundary.draft,
    session: { state: (_key: unknown, topic: string) => ({ topic }) },
    getHistory: async () => ({ success: true, data: {
      turns: [], nextCursor: null, cursor: { epoch: 'provider', seq: 0 }, reset: false, count: 0,
    } }),
  }),
}));
// Exercise the real runtime Result -> AcpLiveSession.create -> store boundary.
// Live transport replication itself has separate session-wire tests.
vi.mock('@gugu/session-wire', async (original) => ({
  ...(await original<typeof import('@gugu/session-wire')>()),
  ReplicaState: class {
    readonly ready = Promise.resolve();
    constructor(private handle: { topic: string }) {}
    current() {
      switch (this.handle.topic) {
        case 'state': return { lifecycle: 'ready', isGenerating: false, queuedPrompts: [], pendingPermissions: [], canSubmit: true };
        case 'agents': case 'terminals': return [];
        case 'config': return {};
        case 'draft': return boundary.liveDraft;
        default: return null;
      }
    }
    onChange(listener: (draft: unknown) => void) {
      if (this.handle.topic !== 'draft') return () => {};
      boundary.draftListeners.add(listener);
      return () => boundary.draftListeners.delete(listener);
    }
    onGone() { return () => {}; }
    async dispose() {}
  },
}));

const storedTurn: TranscriptTurn = {
  id: 'saved-turn', seq: 0, initiator: 'user', items: [
    { kind: 'message', id: 'saved-message', seq: 0, role: 'user', text: 'saved history' },
  ],
};
Object.defineProperty(document, 'fonts', { configurable: true, value: { load: async () => [] } });
Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
  invoke: async (channel: string, request?: { fromSeq?: number }) => channel === 'sessions.getStoredHistory'
    ? { turns: [storedTurn].filter(turn => turn.seq >= (request?.fromSeq ?? 0)), originTurnIds: [], nextCursor: null } : [],
  eventSend: () => {}, eventOn: () => () => {}, getPathForFile: () => '',
} });
const { AcpChatStore } = await import('./acp-chat-store');
type Internals = {
  _bootstrapped: boolean;
  _startInput: () => unknown;
  _runBootstrap: () => Promise<void>;
};
const stores: InstanceType<typeof AcpChatStore>[] = [];
let taskSequence = 0;
function savedTask(missing = false) {
  const id = `saved-${++taskSequence}`;
  const record = { id, providerId: 'codex', providerSessionId: 'original-provider-id',
    ...(missing ? { providerSessionState: 'missing' as const } : {}),
  };
  boundary.records.set(id, record);
  const store = new AcpChatStore(id, 'project');
  stores.push(store);
  const internal = store as unknown as Internals;
  internal._bootstrapped = true;
  internal._startInput = () => ({ sessionId: id, providerId: record.providerId, providerSessionId: record.providerSessionId });
  return { store, record, open: () => internal._runBootstrap() };
}
const history = (store: InstanceType<typeof AcpChatStore>) =>
  store.chatState.transcript.state.committedTurns.map(turn => turn.id);

beforeEach(() => {
  boundary.records.clear(); boundary.toasts.length = 0; boundary.liveDraft = null;
  boundary.engineRev = 0; boundary.draftListeners.clear();
  boundary.start.mockReset().mockResolvedValue({ success: true, data: { providerSessionId: 'original-provider-id' } });
  boundary.queue.mockReset().mockResolvedValue({ success: true, data: { queued: true } });
  boundary.draft.mockReset().mockImplementation(async ({ draft }) => {
    // The real cell ignores stale revisions. Assert the engine's text too, so
    // a successful RPC alone cannot make a lost draft look synchronized.
    if (draft.rev > boundary.engineRev) {
      boundary.engineRev = draft.rev;
      boundary.liveDraft = draft.input ? { ...draft.input, rev: draft.rev, updatedAt: 1 } : null;
      for (const listener of boundary.draftListeners) listener(boundary.liveDraft);
    }
    return { success: true, data: undefined };
  });
});
afterEach(() => {
  stores.splice(0).forEach(store => store.dispose());
  vi.useRealTimers();
});

describe('saved tasks remain open when their provider cannot resume', () => {
  it('keeps stored history and the original cause on a rejected resume, then retries the same ID', async () => {
    const { store, record, open } = savedTask();
    boundary.start.mockResolvedValueOnce({ success: false, error: {
      type: 'initialize_failed', cause: { name: 'Error', message: 'failed to read thread: permission denied' },
    } });
    await expect(open()).resolves.toBeUndefined();
    expect(store.loadError).toEqual({ kind: 'generic', message: 'failed to read thread: permission denied' });
    expect(history(store)).toEqual(['saved-turn']);
    expect(store.historyLoading).toBe(false);
    store.setDraftText('keep this draft');
    expect(store.draftText).toBe('keep this draft');
    store.retry();
    await vi.waitFor(() => expect(store.session).not.toBeNull());
    expect(store.loadError).toBeNull();
    expect(store.draftText).toBe('keep this draft');
    expect(history(store)).toEqual(['saved-turn']);
    expect(boundary.start.mock.calls.map(([request]) => request.input.providerSessionId))
      .toEqual(['original-provider-id', 'original-provider-id']);
    expect(record.providerSessionId).toBe('original-provider-id');
  });

  it('opens a known-missing task without probing or discarding stored history', async () => {
    const { store, open } = savedTask(true);
    await expect(open()).resolves.toBeUndefined();
    expect(store.loadError?.kind).toBe('provider_session_missing');
    expect(history(store)).toEqual(['saved-turn']);
    expect(boundary.start).not.toHaveBeenCalled();
    expect(store.affordances.canSubmit).toBe(false);
  });

  it.each(['submitPrompt', 'queuePrompt'] as const)('%s refuses missing input visibly and keeps its text', async method => {
    const { store, open } = savedTask(true);
    await open();
    store[method]('unsent text');
    expect(store.draftText).toBe('unsent text');
    expect(store.chatState.session.state.pendingPrompt).toBeNull();
    expect(store.queuedPrompts).toEqual([]);
    expect(history(store)).toEqual(['saved-turn']);
    expect(boundary.queue).not.toHaveBeenCalled();
    expect(boundary.start).not.toHaveBeenCalled();
    expect(boundary.toasts.at(-1)?.description)
      .toBe(translateSessionMessage('transcript.condition.providerSessionMissingWithHistory'));
  });

  it('does not overwrite newer input or try syncing a missing session draft', async () => {
    const { store, open } = savedTask(true);
    await open();
    vi.useFakeTimers();
    store.setDraftText('newer input');
    store.submitPrompt('earlier rejected input');
    expect(store.draftText).toBe('newer input');
    boundary.toasts.length = 0;
    await vi.runOnlyPendingTimersAsync();
    expect(boundary.draft).not.toHaveBeenCalled();
    expect(boundary.toasts).toEqual([]);
  });

  it('explicitly re-probes the same missing ID, retaining the mark on another refusal', async () => {
    const { store, record, open } = savedTask(true);
    await open();
    boundary.start.mockResolvedValueOnce({ success: false, error: {
      type: 'provider_session_missing', cause: { name: 'Error', message: 'original provider says thread is absent' },
    } });
    store.retry({ retryMissing: true });
    await vi.waitFor(() => expect(store.loadError?.message).toBe('original provider says thread is absent'));
    expect(record.providerSessionState).toBe('missing');
    expect(record.providerSessionId).toBe('original-provider-id');
    expect(store.canQueueBeforeSession).toBe(false);
    expect(history(store)).toEqual(['saved-turn']);
    expect(boundary.start).toHaveBeenCalledWith({ input: expect.objectContaining({ providerSessionId: 'original-provider-id' }) });
  });

  it('keeps a draft local while an explicit missing-session retry is in flight', async () => {
    const { store, record, open } = savedTask(true);
    await open();
    const resume = Promise.withResolvers<unknown>();
    boundary.start.mockImplementationOnce(() => resume.promise);
    store.retry({ retryMissing: true });
    await vi.waitFor(() => expect(boundary.start).toHaveBeenCalledOnce());
    expect(store.loadError?.kind).toBe('provider_session_missing');
    expect(record.providerSessionState).toBe('missing');
    vi.useFakeTimers();
    store.setDraftText('keep during retry');
    await vi.runOnlyPendingTimersAsync();
    expect(boundary.draft).not.toHaveBeenCalled();
    expect(boundary.toasts).toEqual([]);
    expect(store.draftText).toBe('keep during retry');
    vi.useRealTimers();
    runInAction(() => { delete record.providerSessionState; });
    resume.resolve({ success: true, data: { providerSessionId: 'original-provider-id' } });
    await vi.waitFor(() => expect(store.session).not.toBeNull());
    expect(boundary.draft).toHaveBeenCalledExactlyOnceWith({
      sessionId: store.runtimeSessionId, draft: { rev: 1, input: { text: 'keep during retry' } },
    });
    expect(store.draftText).toBe('keep during retry');
  });

  it('blocks sends during an explicit probe and recovers only after a successful same-ID result', async () => {
    const { store, record, open } = savedTask(true);
    await open();
    const resume = Promise.withResolvers<unknown>();
    boundary.start.mockImplementationOnce(() => resume.promise);
    store.setDraftText('keep while checking');
    store.retry({ retryMissing: true });
    await vi.waitFor(() => expect(boundary.start).toHaveBeenCalledOnce());
    expect(record.providerSessionState).toBe('missing');
    expect(store.affordances.canSubmit).toBe(false);
    store.submitPrompt('refused during check');
    expect(boundary.queue).not.toHaveBeenCalled();
    expect(store.draftText).toBe('keep while checking');
    // Emulate the existing host persistence boundary: only a confirmed success clears it.
    runInAction(() => { delete record.providerSessionState; });
    resume.resolve({ success: true, data: { providerSessionId: 'original-provider-id' } });
    await vi.waitFor(() => expect(store.session).not.toBeNull());
    expect(store.loadError).toBeNull();
    expect(store.affordances.canSubmit).toBe(true);
    expect(store.draftText).toBe('keep while checking');
    expect(history(store)).toEqual(['saved-turn']);
    expect(record.providerSessionId).toBe('original-provider-id');
  });
  it.each(['provider_session_missing', 'adapter_lost'] as const)('a generic retry does not re-probe a missing ID from %s', async kind => {
    const { store, record, open } = savedTask(true);
    await open();
    runInAction(() => { store.loadError = { kind, message: 'the saved provider is unavailable' }; });
    store.retry();
    await vi.waitFor(() => expect(store.historyLoading).toBe(false));
    expect(boundary.start).not.toHaveBeenCalled();
    expect(record.providerSessionState).toBe('missing');
    expect(record.providerSessionId).toBe('original-provider-id');
    expect(store.providerSessionMissing).toBe(true);
    expect(history(store)).toEqual(['saved-turn']);
  });


  it.each([true, false])('does not infer missing re-probe consent before the durable mark arrives (saved ID: %s)', async hasId => {
    const { store, record, open } = savedTask();
    if (!hasId) delete (record as { providerSessionId?: string }).providerSessionId;
    boundary.start.mockResolvedValueOnce({ success: false, error: {
      type: 'provider_session_missing', cause: { name: 'Error', message: 'saved ID is absent' },
    } });
    await open();
    store.retry();
    expect(store.affordances.canSubmit).toBe(false);
    expect(store.canQueueBeforeSession).toBe(false);
    await vi.waitFor(() => expect(store.historyLoading).toBe(false));
    expect(boundary.start).toHaveBeenCalledTimes(1);
    expect(store.loadError?.kind).toBe('provider_session_missing');
    expect(history(store)).toEqual(['saved-turn']);
  });

  it('does not retry a disposed task', async () => {
    const { store, open } = savedTask(true);
    await open();
    store.dispose();
    store.retry({ retryMissing: true });
    await Promise.resolve();
    expect(boundary.start).not.toHaveBeenCalled();
    expect(store.historyLoading).toBe(false);
  });

  it('does not infer reset consent from an absent reference; an explicit retry can still start', async () => {
    const { store, record, open } = savedTask(true);
    await open();
    delete record.providerSessionState;
    delete (record as { providerSessionId?: string }).providerSessionId;
    store.retry();
    await vi.waitFor(() => expect(store.historyLoading).toBe(false));
    expect(boundary.start).not.toHaveBeenCalled();
    expect(store.loadError?.kind).toBe('provider_session_missing');
    store.retry({ retryMissing: true });
    await vi.waitFor(() => expect(store.session).not.toBeNull());
    expect(boundary.start).toHaveBeenCalledExactlyOnceWith({ input: expect.objectContaining({ providerSessionId: undefined }) });
  });

  it.each(['latest draft', ''])('flushes local %j when the engine still equals base', async text => {
    const { store, open } = savedTask();
    boundary.liveDraft = { rev: 5, text: 'shared base', updatedAt: 1 };
    boundary.engineRev = 5;
    await open();
    expect(store.draftText).toBe('shared base');
    runInAction(() => { store.loadError = { kind: 'adapter_lost', message: 'disconnected' }; });
    vi.useFakeTimers();
    store.setDraftText('superseded local'); store.setDraftText(text);
    store.retry();
    await vi.waitFor(() => expect(store.historyLoading).toBe(false));
    await vi.runOnlyPendingTimersAsync();
    expect(store.draftText).toBe(text);
    expect(boundary.liveDraft?.text ?? '').toBe(text);
    expect(store.draftConflict).toBeNull();
    expect(boundary.draft).toHaveBeenCalledTimes(1);
  });

  it.each([2, 3, 9])('adopts engine rev %i when local still equals base', async rev => {
    const { store, open } = savedTask();
    boundary.liveDraft = { rev: 5, text: 'shared base', updatedAt: 1 };
    await open();
    runInAction(() => { store.loadError = { kind: 'adapter_lost', message: 'disconnected' }; });
    boundary.liveDraft = { rev, text: 'other device draft', updatedAt: 2 };
    boundary.engineRev = rev;
    store.retry();
    await vi.waitFor(() => expect(store.historyLoading).toBe(false));
    expect(store.draftText).toBe('other device draft');
    expect(boundary.liveDraft.text).toBe('other device draft');
    expect(store.draftConflict).toBeNull();
    expect(boundary.draft).not.toHaveBeenCalled();
  });

  it.each([2, 3, 9])('keeps both changed texts at engine rev %i until an explicit choice', async rev => {
    const { store, record, open } = savedTask(true);
    await open();
    vi.useFakeTimers();
    store.setDraftText('first local draft'); store.setDraftText('local unsaved draft');
    boundary.liveDraft = { rev, text: 'other device draft', updatedAt: 1 };
    boundary.engineRev = rev;
    delete record.providerSessionState;
    store.retry({ retryMissing: true });
    await vi.waitFor(() => expect(store.session).not.toBeNull());
    await vi.runOnlyPendingTimersAsync();
    expect(store.draftText).toBe('local unsaved draft');
    expect(boundary.liveDraft.text).toBe('other device draft');
    expect(store.draftConflict?.text).toBe('other device draft');
    expect(store.affordances.canSubmit).toBe(false);
    store.setDraftText('local edit while deciding');
    await vi.runOnlyPendingTimersAsync();
    expect(boundary.draft).not.toHaveBeenCalled();
    store.resolveDraftConflict('engine');
    expect(store.draftText).toBe('other device draft');
    expect(boundary.liveDraft.text).toBe('other device draft');
    expect(store.draftConflict).toBeNull();
    expect(boundary.draft).not.toHaveBeenCalled();
  });

  it('overwrites only after choosing the local draft, using the latest engine snapshot', async () => {
    const { store, open } = savedTask();
    store.setDraftText('local draft');
    boundary.liveDraft = { rev: 7, text: 'other draft', updatedAt: 1 };
    boundary.engineRev = 7;
    await open();
    expect(store.draftConflict?.text).toBe('other draft');
    boundary.liveDraft = { rev: 8, text: 'another remote edit', updatedAt: 2 };
    boundary.engineRev = 8;
    for (const listener of boundary.draftListeners) listener(boundary.liveDraft);
    expect(store.draftText).toBe('local draft');
    expect(store.draftConflict?.text).toBe('another remote edit');
    store.resolveDraftConflict('local');
    await vi.waitFor(() => expect(boundary.liveDraft?.text).toBe('local draft'));
    expect(store.draftText).toBe('local draft');
    expect(store.draftConflict).toBeNull();
    expect(boundary.draft).toHaveBeenCalledTimes(1);
  });

  it('does not confuse its own acknowledgement with a remote edit while typing', async () => {
    const { store, open } = savedTask();
    await open();
    vi.useFakeTimers();
    // Delay the acknowledgement until after another local edit.
    const write = Promise.withResolvers<unknown>();
    boundary.draft.mockImplementationOnce(({ draft }) => {
      boundary.liveDraft = { ...draft.input, rev: draft.rev, updatedAt: 1 };
      return write.promise;
    });
    store.setDraftText('sent draft');
    await vi.runOnlyPendingTimersAsync();
    store.setDraftText('newer local draft');
    for (const listener of boundary.draftListeners) listener(boundary.liveDraft);
    expect(store.draftText).toBe('newer local draft');
    expect(store.draftConflict).toBeNull();
    write.resolve({ success: true, data: undefined });
    await vi.runOnlyPendingTimersAsync();
    expect(boundary.liveDraft?.text).toBe('newer local draft');
  });

  it('accepts an older echo while two local writes are still in flight', async () => {
    const { store, open } = savedTask();
    await open();
    vi.useFakeTimers();
    const replies = [Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>()];
    boundary.draft.mockImplementationOnce(() => replies[0]!.promise)
      .mockImplementationOnce(() => replies[1]!.promise);
    store.setDraftText('first write');
    await vi.runOnlyPendingTimersAsync();
    store.setDraftText('second write');
    await vi.runOnlyPendingTimersAsync();
    expect(boundary.draft).toHaveBeenCalledTimes(2);
    const writes = boundary.draft.mock.calls.map(([request]) => request.draft);
    // Both RPCs are still pending when the first engine echo arrives.
    boundary.liveDraft = { ...writes[0].input, rev: writes[0].rev, updatedAt: 1 };
    for (const listener of boundary.draftListeners) listener(boundary.liveDraft);
    expect(store.draftText).toBe('second write');
    expect(boundary.liveDraft?.text).toBe('first write');
    expect(store.draftConflict).toBeNull();
    await vi.runOnlyPendingTimersAsync();
    expect(boundary.draft).toHaveBeenCalledTimes(2);
    boundary.liveDraft = { ...writes[1].input, rev: writes[1].rev, updatedAt: 2 };
    for (const listener of boundary.draftListeners) listener(boundary.liveDraft);
    replies.forEach(reply => reply.resolve({ success: true, data: undefined }));
    await vi.runOnlyPendingTimersAsync();
    expect(store.draftText).toBe('second write');
    expect(boundary.liveDraft?.text).toBe('second write');
    expect(store.draftConflict).toBeNull();
    expect(boundary.draft).toHaveBeenCalledTimes(2);
  });

  it('keeps the next typed draft when the live engine clears a submitted prompt', async () => {
    const { store, open } = savedTask();
    boundary.liveDraft = { rev: 5, text: 'submitted prompt', updatedAt: 1 };
    boundary.engineRev = 5;
    await open();
    vi.useFakeTimers();
    store.setDraftText('next draft');
    boundary.liveDraft = null;
    for (const listener of boundary.draftListeners) listener(null);
    expect(store.draftText).toBe('next draft');
    expect(store.draftConflict).toBeNull();
    await vi.runOnlyPendingTimersAsync();
    expect(boundary.liveDraft?.text).toBe('next draft');
  });

  it.each(['submitPrompt', 'queuePrompt'] as const)('%s visibly rejects a still-conflicting draft', async method => {
    const { store, open } = savedTask();
    store.setDraftText('local input');
    boundary.liveDraft = { rev: 1, text: 'remote input', updatedAt: 1 };
    boundary.engineRev = 1;
    await open();
    store[method]('local input');
    expect(store.draftText).toBe('local input');
    expect(boundary.liveDraft.text).toBe('remote input');
    expect(boundary.queue).not.toHaveBeenCalled();
    expect(boundary.toasts.at(-1)?.description).toBe(translateSessionMessage('composer.draftConflict'));
  });

  it('does not write an untouched draft when a session becomes live', async () => {
    const { open } = savedTask();
    await open();
    expect(boundary.draft).not.toHaveBeenCalled();
  });

});

// A read of the durable field belongs to the getter even when its spelling is
// aliased or compared differently. Scan the whole module, including outside classes.
function missingStateReadsOutsideGetter(source: string): string[] {
  const file = ts.createSourceFile('acp-chat-store.ts', source, ts.ScriptTarget.Latest, true);
  const store = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AcpChatStore');
  if (!store || !ts.isClassDeclaration(store)) throw new Error('AcpChatStore declaration not found');
  const getter = store.members.find(node => ts.isGetAccessorDeclaration(node) && node.name.getText(file) === 'providerSessionMissing');
  if (!getter || !ts.isGetAccessorDeclaration(getter) || !getter.body) throw new Error('Missing predicate getter not found');
  const body = getter.body;
  const outside: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === 'providerSessionState'
      && (node.pos < body.pos || node.end > body.end)) {
      outside.push(node.parent.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return outside;
}

// Resolve a source path, not Vite's new-URL asset transform (which can yield a data URL).
const storeSource = () => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'acp-chat-store.ts'), 'utf8');
it('forbids reading providerSessionState outside the one missing getter', () => {
  expect(missingStateReadsOutsideGetter(storeSource())).toEqual([]);
});
it.each([
  "if (record.providerSessionState !== 'missing') {}",
  "if (record.providerSessionState == 'missing') {}",
  "if ('missing' === record.providerSessionState) {}",
  "switch (record.providerSessionState) { case 'missing': break; }",
  "const { providerSessionState: state } = record; if (state === 'missing') {}",
  "const key = 'providerSessionState'; const state = record[key];",
  "function outsideClass() { return record.providerSessionState; }",
])('the single-source guard rejects %s', copiedRead => {
  expect(missingStateReadsOutsideGetter(`${storeSource()}\n${copiedRead}`)).not.toEqual([]);
});
