// @vitest-environment jsdom
/**
 * The chat surface must not hold on to a dead session handle — whether the host stopped the session on
 * purpose (#6497) or the runtime process was restarted underneath it (#7327).
 *
 * ## Before the fix
 *
 * #6497 (mac1, real Electron, 2026-09-25): undo right after archiving, switching to code mode and straight
 * back, a parent's `session_stop` on its child — all three stop the session in the runtime (the live
 * instance is disposed). session-wire does not tell its subscribers, so `this.session` kept pointing at a
 * session that no longer exists: "Failed to send message <id>" + "Failed to sync draft", the turn stuck on
 * Working, and the engine never came back.
 *
 * #7327 (real Electron dev build, 2026-10-16): the local ACP runtime process is killed and the host starts a
 * new one (on the server side: an account process restarted during an upgrade). The new process has no such
 * session and the old one never got to send `closed`. Reconnecting the state replica is refused (NOT_FOUND)
 * and the replica silently keeps its old value: every keystroke popped "draft not saved", and the sent line
 * stayed "processing…".
 *
 * ## The contract now
 *
 * The runtime sends `lifecycle: 'closed'` once more before it disposes (see the same-numbered case in
 * session-manager.test.ts); a replica's `onGone` is treated as the same state. On either: unsubscribe, set
 * `session` to null, keep the record on screen, and do **not** restart on the spot. Typing reports no error;
 * the next line goes to the host through custody, and the host's session-life starts the session (the page
 * never starts it itself). The handle is kept: its replicas follow the session id, so when the host brings
 * the session back by itself (a schedule, a delivery, a reopen) it re-seeds and this side re-attaches (10-19).
 *
 * ## Can the criteria fail?
 *
 * Yes: delete the `if (next.lifecycle === 'closed') …` line in `_subscribeLiveSession` and the "closed" rows
 * of the first table go red; drop the `sessionState.onGone` subscription there and the "gone" rows go red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { runInAction } from 'mobx';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { installAcpChatStoreHost, replica } from './acp-chat-store.test-host';

vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({}),
}));
const custody = vi.fn(async () => {});
vi.mock('./queue-native-input', () => ({ sendThroughCustody: custody, canQueueNativeInput: () => false }));

const toasts: Array<{ title: string; description?: string }> = [];
vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: (arg: { title: string }) => {
    toasts.push(arg);
  },
}));

type StoreModule = typeof import('./acp-chat-store');
type StoreCtor = StoreModule['AcpChatStore'];
type Store = InstanceType<StoreCtor>;
const storedHistory = vi.fn(async () => ({ turns: [] as TranscriptTurn[], originTurnIds: [] as string[], nextCursor: null }));
const turn = (id: string): TranscriptTurn => ({ id, seq: 0, initiator: 'user', items: [] }) as unknown as TranscriptTurn;

installAcpChatStoreHost((channel: string) => channel === 'sessions.getStoredHistory' ? storedHistory() : Promise.resolve([]));
const { AcpChatStore }: StoreModule = await import('./acp-chat-store');

const readyState = {
  lifecycle: 'ready',
  activeTurnId: null,
  pendingPermissions: [],
  lastStopReason: null,
  lastTurnOutcome: 'none',
  queuedPrompts: [],
  backgroundAgentCount: 0,
  isGenerating: false,
  canSubmit: true,
  canCancel: false,
  failure: null,
};
const closedState = { ...readyState, lifecycle: 'closed', canSubmit: false };

function fakeSession() {
  const disposed = { value: false };
  const sendPrompt = vi.fn().mockResolvedValue({ success: true, data: undefined });
  // What a restarted runtime answers for this session (session-manager `sessionNotFound`): refused.
  const setPromptDraft = vi.fn().mockResolvedValue({
    success: false,
    error: { type: 'conversation_not_found', message: 'conv' },
  });
  const draftReady = new Set<() => void>();
  let connected = true;
  const session = {
    agents: replica([] as unknown[]),
    sessionState: replica<Record<string, unknown>>(readyState),
    activeTurn: replica(null),
    plan: replica(null),
    draft: replica<{ rev: number; text: string } | null>(null),
    canSyncDraft: () => connected,
    onDraftSyncReady: (listener: () => void) => { draftReady.add(listener); return () => draftReady.delete(listener); },
    draftConnectionGeneration: 0,
    disconnectDraft() { connected = false; session.draftConnectionGeneration++; },
    reconnectDraft() { connected = true; for (const listener of draftReady) listener(); },
    terminals: replica([] as unknown[]),
    config: replica({}),
    sendPrompt,
    setPromptDraft,
    dispose: () => {
      disposed.value = true;
    },
  };
  return { session, disposed, sendPrompt };
}

type Internal = {
  _bootstrapped: boolean;
  _bootstrapsInFlight: number;
  _subscribeLiveSession: (session: unknown) => void;
  _runBootstrap: () => Promise<void>;
};

let seq = 0;
function attachedStore() {
  seq += 1;
  const store = new AcpChatStore(`conv-host-gone-${seq}`, 'proj-1');
  const internal = store as unknown as Internal;
  // Like a real open, the first thing recorded is "an open is in flight" (see `_runBootstrap`); the stub
  // goes no further — the cases want exactly that window. Without it the store would think no open runs.
  const boot = vi.spyOn(internal, '_runBootstrap').mockImplementation(async () => {
    runInAction(() => {
      internal._bootstrapsInFlight += 1;
    });
  });
  const { session, disposed, sendPrompt } = fakeSession();
  runInAction(() => {
    internal._bootstrapped = true;
    store.historyLoading = false;
    store.session = session as unknown as Store['session'];
    internal._subscribeLiveSession(session);
  });
  return { store, session, disposed, sendPrompt, boot };
}

type Session = ReturnType<typeof fakeSession>['session'];
const endings: Array<[string, (session: Session) => void]> = [
  ['the host stopped it (closed, #6497)', (session) => session.sessionState.push(closedState)],
  ['the runtime restarted (replica gone, #7327)', (session) => session.sessionState.gone()],
];

beforeEach(() => {
  toasts.length = 0;
  custody.mockClear();
  storedHistory.mockReset();
  storedHistory.mockResolvedValue({ turns: [], originTurnIds: [], nextCursor: null });
});

describe.each(endings)('after %s', (_name, end) => {
  it('session is null, the UI subscriptions are dropped, the record stays, nothing restarts on the spot', () => {
    const { store, session, disposed, boot } = attachedStore();
    // Positive control: the scenario holds — the handle is there, the state subscription is attached.
    expect(store.session).not.toBeNull();
    expect(session.sessionState.listenerCount()).toBeGreaterThan(1);

    end(session);

    expect(store.session, 'a handle kept as a live session = the next line goes to a session that does not exist').toBeNull();
    expect(disposed.value, 'the handle is kept so it can follow the session when it comes back').toBe(false);
    expect(session.sessionState.listenerCount(), 'only the one waiting for it to come back is left').toBe(1);
    expect(store.loadError, 'not a failure of this session: there is no error to report').toBeNull();
    expect(store.affordances.isWorking).toBe(false);
    expect(store.affordances.canSubmit, 'sending must still work — it starts then').toBe(true);
    expect(boot, 'nobody asked for it now; the chat surface does not start it').not.toHaveBeenCalled();
  });

  it('typing afterwards keeps the draft locally and pops no "Failed to sync draft"', async () => {
    vi.useFakeTimers();
    try {
      const { store, session } = attachedStore();
      end(session);
      for (const text of ['草', '草稿', '草稿测', '草稿测试']) {
        store.setDraftText(text);
        await vi.advanceTimersByTimeAsync(400);
      }
      expect(store.draftText).toBe('草稿测试');
      expect(toasts.map((t) => t.title)).not.toContain(translateSessionMessage('acpFailure.syncDraft'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('every line sent afterwards goes to the host through custody; the page does not open, ❌ the dead handle', () => {
    const { store, session, sendPrompt, boot } = attachedStore();
    end(session);
    store.submitPrompt('再加 1 等于多少');
    store.submitPrompt('还有吗');
    expect((custody.mock.calls as unknown as [unknown, string][]).map(([, text]) => text)).toEqual(['再加 1 等于多少', '还有吗']);
    expect(custody).toHaveBeenCalledWith(store, '还有吗', [], []);
    expect(boot).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(toasts.map((t) => t.title)).not.toContain(translateSessionMessage('acpFailure.sendMessage'));
  });

  it('a late ending on the old handle leaves the current one alone (a store that already swapped handles)', () => {
    const { store, session } = attachedStore();
    const { session: replacement } = fakeSession();
    runInAction(() => {
      store.session = replacement as unknown as Store['session'];
    });
    end(session);
    expect(store.session).toBe(replacement);
  });
});

describe('#6497 the host stopped the session', () => {
  it('makes a lost executor resumable by the next prompt through the custody send', async () => {
    const { store, session, boot, sendPrompt } = attachedStore();
    session.sessionState.push({ ...readyState, lifecycle: 'lost', failure: { message: 'executor exited' } });
    expect(store.session).toBeNull();
    expect(store.loadError).toMatchObject({ kind: 'adapter_lost', message: 'executor exited' });
    expect(store.affordances.canSubmit).toBe(true);
    expect(boot).not.toHaveBeenCalled();
    // Further loss updates are not a replacement executor becoming ready.
    session.sessionState.push({ ...readyState, lifecycle: 'lost', failure: { message: 'resume failed' } });
    expect(store.session).toBeNull();
    expect(store.affordances.canSubmit).toBe(true);
    expect(boot).not.toHaveBeenCalled();
    store.submitPrompt('resume the original conversation');
    expect(custody).toHaveBeenCalledWith(store, 'resume the original conversation', [], []);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(boot, 'the host starts it; the page attaches when it is ready').not.toHaveBeenCalled();
  });

  // 10-19: a schedule / delivery brought the stopped session back, the owner watched the task page not move,
  // and the queued messages only appeared after they sent "1".
  it('when the host brings the session back itself, the kept handle follows and re-attaches (attach only), without waiting for a line', () => {
    const { session, disposed, boot } = attachedStore();
    session.sessionState.push(closedState);
    session.sessionState.push(closedState, { kind: 'seed' });
    session.sessionState.push({ ...readyState, lifecycle: 'starting' }, { kind: 'seed' });
    session.sessionState.push({ ...readyState, lifecycle: 'replaying' });
    expect(boot, 'still stopped / still starting: attaching now would miss part of the engine history').not.toHaveBeenCalled();

    session.sessionState.push({ ...readyState, lifecycle: 'working' });

    expect(boot).toHaveBeenCalledTimes(1);
    expect(boot).toHaveBeenCalledWith({ attachOnly: true });
    expect(disposed.value, 're-attaching gives back the kept handle').toBe(true);
  });

  // Reviewer: exercise the existing closed -> ready -> reattach callbacks.
  it('clears a model rejection when a host reload confirms the replacement', async () => {
    const { store, session, boot } = attachedStore();
    (session as unknown as { setModelOption: unknown }).setModelOption = vi.fn().mockResolvedValue({ success: false, error: { type: 'set_config_failed', cause: { name: 'RequestError', message: 'unknown model: retired-model' } } });
    await store.setModel('retired-model');
    expect(store.modelSettingError).toBe(translateSessionMessage('taskError.settingFailedRetry'));
    session.sessionState.push(closedState);
    expect(store.session).toBeNull();
    const next = fakeSession().session;
    next.config.push({ modelOptions: { selected: 'replacement-model', available: [] } });
    boot.mockImplementation(async () => {
      runInAction(() => {
        store.session = next as unknown as Store['session'];
        (store as unknown as Internal)._subscribeLiveSession(next);
      });
    });
    session.sessionState.push(readyState);
    await Promise.resolve();
    expect(boot).toHaveBeenCalledOnce();
    expect(store.model).toBe('replacement-model');
    expect(store.modelSettingError).toBeNull();
  });

  it.each(['model-first', 'ready-first'] as const)('waits for both a usable reloaded session and model read-back (%s)', async (order) => {
    const { store, session, boot } = attachedStore();
    (session as unknown as { setModelOption: unknown }).setModelOption = vi.fn().mockResolvedValue({ success: false, error: new Error('model rejected') });
    await store.setModel('retired-model');
    session.sessionState.push(closedState);
    const next = fakeSession().session;
    next.sessionState.push({ ...readyState, lifecycle: 'starting' });
    boot.mockImplementation(async () => {
      runInAction(() => {
        store.session = next as unknown as Store['session'];
        (store as unknown as Internal)._subscribeLiveSession(next);
      });
    });
    session.sessionState.push(readyState);
    await Promise.resolve();
    expect(store.modelSettingError).toBe(translateSessionMessage('taskError.settingFailedRetry'));
    if (order === 'model-first') next.config.push({ modelOptions: { selected: 'replacement-model', available: [] } });
    else next.sessionState.push(readyState);
    expect(store.modelSettingError).toBe(translateSessionMessage('taskError.settingFailedRetry'));
    if (order === 'model-first') next.sessionState.push(readyState);
    else next.config.push({ modelOptions: { selected: 'replacement-model', available: [] } });
    expect(store.modelSettingError).toBeNull();
  });
});

describe('#7327 the runtime process restarted', () => {
  it.each(['the newest unsent draft', ''])('#1449 keeps %j locally while offline, then writes it once after reattachment', async latest => {
    vi.useFakeTimers();
    try {
      const { store, session } = attachedStore();
      session.setPromptDraft.mockResolvedValue({ success: true, data: undefined });
      session.disconnectDraft();
      store.setDraftText('obsolete queued text');
      await vi.advanceTimersByTimeAsync(400);
      store.setDraftText(latest);
      await vi.advanceTimersByTimeAsync(400);
      expect(session.setPromptDraft).not.toHaveBeenCalled();
      expect(store.draftText).toBe(latest);
      session.draft.push({ rev: 100, text: 'old remote snapshot' });
      expect(store.draftText).toBe(latest);
      session.reconnectDraft();
      await vi.advanceTimersByTimeAsync(400);
      expect(session.setPromptDraft).toHaveBeenCalledOnce();
      expect(session.setPromptDraft).toHaveBeenCalledWith({ rev: 101, input: latest ? { text: latest } : null });
      expect(toasts).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('#1449 does not apply a late result from the previous connection to the recovered draft', async () => {
    vi.useFakeTimers();
    try {
      const { store, session } = attachedStore();
      let finish!: (result: unknown) => void;
      session.setPromptDraft.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      session.setPromptDraft.mockResolvedValue({ success: true, data: undefined });
      store.setDraftText('previous connection');
      await vi.advanceTimersByTimeAsync(400);
      session.disconnectDraft();
      store.setDraftText('newest edit');
      session.reconnectDraft();
      finish({ success: false, error: { type: 'conversation_not_found', message: 'old runtime id' } });
      await vi.advanceTimersByTimeAsync(400);
      expect(session.setPromptDraft).toHaveBeenCalledTimes(2);
      expect(session.setPromptDraft).toHaveBeenLastCalledWith({ rev: expect.any(Number), input: { text: 'newest edit' } });
      expect(toasts).toEqual([]);
      expect(store.draftText).toBe('newest edit');
    } finally { vi.useRealTimers(); }
  });

  it('#1449 shows a readable typed error for a real missing-session draft failure', async () => {
    vi.useFakeTimers();
    try {
      const { store, session } = attachedStore();
      session.setPromptDraft.mockResolvedValue({ success: false, error: { type: 'conversation_not_found', message: '16dd43f4-2ba2-4887-a4ff-b509240a36e6' } });
      store.setDraftText('keep my words');
      await vi.advanceTimersByTimeAsync(400);
      expect(store.draftText).toBe('keep my words');
      expect(toasts).toEqual([{ key: `session-action:${store.sessionId}:acpFailure.syncDraft`, title: translateSessionMessage('acpFailure.syncDraft'), description: translateSessionMessage('acpFailure.sessionUnavailable'), variant: 'destructive' }]);
    } finally { vi.useRealTimers(); }
  });

  it('#1449 preserves actionable non-lifecycle failures', async () => {
    vi.useFakeTimers();
    try {
      const { store, session } = attachedStore();
      session.setPromptDraft.mockRejectedValue(new Error('Access to the session was revoked'));
      store.setDraftText('keep my words');
      await vi.advanceTimersByTimeAsync(400);
      expect(toasts[0]?.description).toBe(translateSessionMessage('taskError.settingFailedRetry'));
      expect(JSON.stringify(toasts)).not.toContain('Access to the session was revoked');
      expect(store.draftText).toBe('keep my words');
    } finally { vi.useRealTimers(); }
  });

  it('discards a running frame on Gone and reads the recovered stored history', async () => {
    const { store, session, boot } = attachedStore();
    store.chatState.transcript.activeTurn.set(turn('stale-frame'));
    store.chatState.session.setGenerating(true);
    storedHistory.mockResolvedValue({ turns: [turn('recovered')], originTurnIds: [], nextCursor: null });
    expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('stale-frame');
    expect(store.chatState.session.state.generating).toBe(true);

    session.sessionState.gone();

    expect(store.session).toBeNull();
    expect(store.chatState.transcript.state.activeTurnSnapshot).toBeNull();
    expect(store.chatState.session.state.generating).toBe(false);
    await vi.waitFor(() => expect(store.chatState.transcript.state.committedTurns.map((item) => item.id)).toEqual(['recovered']));
    expect(storedHistory).toHaveBeenCalledTimes(1);
    expect(boot).not.toHaveBeenCalled();
    store.dispose();
  });

  it('keeps normal Closed handling separate from Gone recovery', () => {
    const { store, session } = attachedStore();
    store.chatState.transcript.activeTurn.set(turn('retained-frame'));

    session.sessionState.push({ ...readyState, lifecycle: 'closed' });

    expect(store.session).toBeNull();
    expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('retained-frame');
    expect(storedHistory).not.toHaveBeenCalled();
    store.dispose();
  });
});
