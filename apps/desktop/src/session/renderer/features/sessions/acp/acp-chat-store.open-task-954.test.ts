// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInAction } from 'mobx';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import type { TranscriptTurn } from '@gugu/session-core/acp';

const boundary = vi.hoisted(() => ({
  records: new Map<string, { id: string; providerId: string; providerSessionId: string; providerSessionState?: 'missing' }>(),
  start: vi.fn(), queue: vi.fn(), draft: vi.fn(),
  liveDraft: null as { rev: number; text: string; updatedAt: number } | null,
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
    onChange() { return () => {}; }
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
  boundary.start.mockReset().mockResolvedValue({ success: true, data: { providerSessionId: 'original-provider-id' } });
  boundary.queue.mockReset().mockResolvedValue({ success: true, data: { queued: true } });
  boundary.draft.mockReset().mockResolvedValue({ success: true, data: undefined });
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
    expect(store.loadError).toBeNull();
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

  it('ordinary retry still starts fresh after the host clears the old provider reference', async () => {
    const { store, record, open } = savedTask(true);
    await open();
    // Existing Start fresh host contract, not consent to re-probe the missing ID.
    delete record.providerSessionState;
    (record as { providerSessionId: string | null }).providerSessionId = null;
    store.retry();
    await vi.waitFor(() => expect(store.session).not.toBeNull());
    expect(boundary.start).toHaveBeenCalledExactlyOnceWith({
      input: expect.objectContaining({ providerSessionId: null }),
    });
  });

  it.each(['latest draft', ''])('flushes the latest pending draft %j once on recovery, including a clear', async text => {
    const { store, record, open } = savedTask(true);
    await open();
    vi.useFakeTimers();
    store.setDraftText('superseded draft');
    store.setDraftText(text);
    // Recovery happens before the debounce; it must cancel that pending timer.
    boundary.liveDraft = { rev: 0, text: 'older engine draft', updatedAt: 1 };
    runInAction(() => { delete record.providerSessionState; });
    store.retry({ retryMissing: true });
    await vi.waitFor(() => expect(store.session).not.toBeNull());
    expect(boundary.draft).toHaveBeenCalledExactlyOnceWith({
      sessionId: store.runtimeSessionId,
      draft: { rev: 2, input: text ? { text } : null },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(boundary.draft).toHaveBeenCalledTimes(1);
    expect(store.draftText).toBe(text);
  });

  it.each([2, 3])('acknowledges engine revision %i without overwriting its newer draft', async rev => {
    const { store, record, open } = savedTask(true);
    await open();
    vi.useFakeTimers();
    store.setDraftText('first local draft');
    store.setDraftText('unacknowledged local draft');
    boundary.liveDraft = { rev, text: 'newer draft from another device', updatedAt: 1 };
    runInAction(() => { delete record.providerSessionState; });
    store.retry({ retryMissing: true });
    await vi.waitFor(() => expect(store.session).not.toBeNull());
    await vi.runOnlyPendingTimersAsync();
    expect(boundary.draft).not.toHaveBeenCalled();
    // A subsequent genuine local edit advances from the acknowledged revision.
    store.setDraftText('new edit after recovery');
    await vi.runOnlyPendingTimersAsync();
    expect(boundary.draft).toHaveBeenCalledExactlyOnceWith({
      sessionId: store.runtimeSessionId,
      draft: { rev: rev + 1, input: { text: 'new edit after recovery' } },
    });
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

const storeSource = () => readFileSync(new URL('./acp-chat-store.ts', import.meta.url), 'utf8');
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
