// Regression of the six original #1344 paint-boundary counterexamples, under the approved send/receive distinction.
// Real: editor/composer -> store.submitPrompt -> custody bridge -> IndexedDB outbox,
// Life mirror/_drawLifeHead, connectSession, transcript view and both queue components.
// Controlled boundaries: host RPC, host Life events, and runtime live replicas.
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { observable, reaction, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { createChatView, type TranscriptTurn } from '@gugu/session-chat-ui';
import { ChatComposer, MessageProvider, type PromptEditorRef } from '@gugu/session-ui/react/components';
import type { LifeView } from '@shared/core/sessions/session-life';
import { i18n } from '@/i18n';
import { registerSessionLocaleResources } from '@renderer/localization/locale-store';
import { nativeComposerAppearance, nativeChatAppearance } from '@renderer/lib/chat/native-chat-appearance.css';
import { SessionInputOutbox, openSessionInputStorage, type SessionInput } from '@/lib/sessionInputOutbox';
import { state as outboxState, changed, releaseQueuedSessionInput, subscribeSessionInputs } from '@/lib/sessionInputOutboxBridge';
import { SessionInputQueue } from '@/components/chat/SessionInputQueue';
import { isTranscriptDelivery } from '@/lib/pendingSessionDeliveries';
import { sessionLifeView } from '@renderer/features/sessions/stores/session-life-views';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { rpcOn } from '@renderer/lib/ipc';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';
import '@/i18n/registerMessagingCatalog';

const hostRpc = vi.hoisted(() => ({ invoke: vi.fn(), eventOn: vi.fn(), toast: vi.fn() }));
vi.mock('@renderer/lib/machine-clients', () => ({
  machineClient: () => ({ api: { invoke: hostRpc.invoke, eventOn: hostRpc.eventOn, eventSend() {} } }),
  machineLinkState: () => 'open', machineLinkHandingOff: () => false,
  reportMachineOutdated: () => {},
  onMachineReconnected: () => () => {}, subscribeMachineLink: () => () => {},
  onEachMachine: () => () => {}, closeMachineClient() {}, reconnectMachine() {}, machineLabel: () => 'fixture-remote',
  machineWireTransport: () => { throw new Error('Runtime replicas are controlled at the service boundary'); },
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: (value: unknown) => hostRpc.toast(value) }));
Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
  invoke: (...args: unknown[]) => hostRpc.invoke(...args), eventOn: (...args: unknown[]) => hostRpc.eventOn(...args),
  eventSend() {}, getPathForFile: () => '',
} });
const { AcpChatStore } = await import('@renderer/features/sessions/acp/acp-chat-store');

function replica<T>(initial: T) {
  const box = observable.box(initial, { deep: false });
  const listeners = new Set<(next: T) => void>();
  return { current: () => box.get(), ready: Promise.resolve(), onGone: () => () => {},
    onChange(listener: (value: T) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next: T) { runInAction(() => box.set(next)); for (const listener of listeners) listener(next); },
  };
}
function turn(id: string, itemId: string, text = '先前的工作'): TranscriptTurn {
  return { id, seq: 1, initiator: 'user', startedAt: Date.now() - 15_000,
    items: [{ kind: 'message', id: itemId, seq: 0, role: 'user', text }] };
}
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const sameText = '好';
const cases = ['A-queue-first', 'A-active-first', 'B-life-first', 'B-active-first', 'direct-ack-first', 'direct-echo-first', 'B-mixed-legacy', 'B-durable-first-frame'] as const;

it.each(cases)('%s: record each actual paint boundary before Q starts', async (name) => {
  await page.viewport(1000, 800);
  await i18n.changeLanguage('zh-CN'); registerSessionLocaleResources();
  const sessionId = `frames-${name}-${crypto.randomUUID()}`;
  const deviceId = `frames-device-${name}`;
  machineRegistry.register(deviceId, [sessionId]);
  cleanup.push(() => machineRegistry.forgetMachine(deviceId));
  const events = new Map<string, Set<(value: unknown) => void>>();
  const rpcCalls: unknown[] = [];
  const held: Array<{ input: SessionInput; accept: () => void }> = [];
  const received: SessionInput[] = [];
  let life: LifeView = { sessionId, version: 1, kind: 'ready', stage: null, hold: null, failure: null,
    lastExit: null, nativeSession: null, pending: { count: 0, items: [] } };
  hostRpc.eventOn.mockImplementation((channel: string, cb: (data: unknown) => void) => {
    const set = events.get(channel) ?? new Set(); events.set(channel, set); set.add(cb); return () => { set.delete(cb); };
  });
  hostRpc.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    rpcCalls.push({ channel, args });
    if (channel === 'sessions.lifeView') return life;
    if (channel === 'sessionTimeline.sessionSend') {
      const request = args[0] as { clientMessageId: string };
      const input = received.find(input => input.id === request.clientMessageId)!;
      return new Promise(resolve => held.push({ input, accept: () => resolve({ ok: true, value: { accepted: 'queued', clientMessageId: request.clientMessageId } }) }));
    }
    if (channel === 'integrations.list') return [];
    return [];
  });

  const busy = name.startsWith('B-');
  const direct = name.startsWith('direct-');
  const foreground = turn('foreground-A', 'foreground-A:user', busy ? sameText : '先前的工作');
  const firstSame = { ...turn('previous-same', 'previous-same:user', sameText), endedAt: Date.now() - 14_000, outcome: { kind: 'done' as const } };
  let historyTurns: TranscriptTurn[] = [];
  const readyState = { lifecycle: 'ready', activeTurnId: null, queuedPrompts: [], pendingPermissions: [], isGenerating: false,
    backgroundAgentCount: 0, backgroundCommandCount: 0, lastTurnOutcome: 'none', lastStopReason: null, canSubmit: true, canCancel: false };
  const session = {
    activeTurn: replica<TranscriptTurn | null>(null),
    sessionState: replica({ ...readyState, ...(busy ? { lifecycle: 'working', activeTurnId: foreground.id, isGenerating: true } : {}) }),
    agents: replica([]), config: replica({}), plan: replica(null), terminals: replica([]), draft: replica(null),
    canSyncDraft: () => true, onDraftSyncReady: () => () => {}, cancelTurn: vi.fn(async () => ({ success: true, data: undefined })),
    setPromptDraft: async () => ({ success: true, data: undefined }),
    changeQueuePromptOrder: vi.fn(async (ids: string[]): Promise<{ success: true; data: undefined }> => {
      const current = session.sessionState.current();
      session.sessionState.set({ ...current, queuedPrompts: ids.map(id => current.queuedPrompts.find(input => (input as { id: string }).id === id)) } as never);
      return { success: true, data: undefined };
    }),
    getHistory: async () => ({ success: true, data: { turns: historyTurns, count: historyTurns.length,
      nextCursor: null, cursor: { epoch: 'fixture', seq: 0 }, reset: false } }), dispose() {},
  };
  const store = new AcpChatStore(sessionId, 'frames-project');
  cleanup.push(() => store.dispose());
  const internals = store as unknown as { session: unknown; _subscribeLiveSession(session: unknown): void; _drawLifeHead(view: LifeView | null): void };
  runInAction(() => { internals.session = session; store.historyLoading = false; });
  internals._subscribeLiveSession(session);

  let current = true;
  const own = outboxState();
  const durable = await openSessionInputStorage();
  let releasePersistence!: () => void;
  const persistenceGate = new Promise<void>(resolve => { releasePersistence = resolve; });
  if (name !== 'B-durable-first-frame') releasePersistence();
  const storage = { ...durable, put: async (input: SessionInput) => { await persistenceGate; await durable.put(input); } };
  const accountId = `frames-account-${crypto.randomUUID()}`;
  let refresh: Promise<void> = Promise.resolve();
  let refreshRevision = 0;
  const publishRows = (persisted?: readonly SessionInput[]) => {
    const revision = ++refreshRevision;
    refresh = (async () => { const rows = persisted ?? await queue.list(); if (!current || revision !== refreshRevision) return; own.rows = rows; changed(); })();
  };
  const queue = new SessionInputOutbox(accountId, storage, async input => {
    received.push(input);
    // Transport boundary only: held composer entries must never reach this callback.
    const result = await rpcOn(input.deviceId).sessionTimeline.sessionSend({ conversationId: input.sessionId,
      text: input.text, clientMessageId: input.id });
    if (!result.ok) throw new Error(result.error.message);
    if (result.value.clientMessageId !== input.id) throw new Error('Unexpected host input receipt');
  }, () => current, publishRows);
  own.accountId = accountId; own.queue = Promise.resolve(queue); own.rows = []; own.valid = () => current;
  cleanup.push(async () => {
    current = false;
    releasePersistence();
    for (const pending of held.splice(0)) pending.accept();
    await queue.flush();
    for (const row of await queue.list()) await storage.remove(accountId, row.id);
    own.rows = []; own.queue = null; own.valid = () => false; changed();
  });
  // Exact production bootstrap observation wiring, without _open (runtime/network bootstrap is outside this component fixture).
  cleanup.push(reaction(() => [sessionLifeView(sessionId), store.transcriptRevision, store.historyLoading] as const,
    ([view]) => internals._drawLifeHead(view), { fireImmediately: true }));
  cleanup.push(subscribeSessionInputs(() => internals._drawLifeHead(sessionLifeView(sessionId))));
  await until('real Life mirror receives ready', () => sessionLifeView(sessionId)?.version === 1);

  const host = document.createElement('div'); host.className = `gugu-skin emlight ${nativeComposerAppearance} ${nativeChatAppearance}`;
  host.style.cssText = 'position:fixed;inset:0;width:1000px;height:800px'; document.body.append(host);
  const view = createChatView({ parent: host, context: store.chatContext, state: store.chatState,
    composer: 'slot', stickToBottom: true, pinUserMessages: true });
  store.bindView(view);
  cleanup.push(() => store.bindView(null));
  store.chatContext.setLayout({ preset: 'double', userGutter: 0, agentConversation: true });
  cleanup.push(() => { view.dispose(); host.remove(); });
  const composerRoot = createRoot(view.composerSlot!);
  const editorApiRef = createRef<PromptEditorRef>();
  cleanup.push(() => composerRoot.unmount());
  const Compose = observer(() => {
    const currentLife = sessionLifeView(sessionId);
    const t = i18n.getFixedT('zh-CN', 'session');
    const submit = async (text: string) => {
      await store.submitPrompt(text);
      flushSync(() => { if (editorApiRef.current?.getText() === text) editorApiRef.current.clear(); });
    };
    return <MessageProvider locale="zh-CN" translate={(key, values) => t(key, { ...values, interpolation: { prefix: '{', suffix: '}' } })}>
      <SessionInputQueue sessionId={sessionId} waitingForConnection life={currentLife}
        inTranscript={[...(store.transcriptPendingId ? [store.transcriptPendingId] : []), ...currentLife?.pending.items.filter(isTranscriptDelivery).map(row => row.messageId) ?? []]} />
      <ChatComposer isWorking={store.affordances.isWorking} canSubmit queuedPrompts={store.queuedPrompts}
        editorApiRef={editorApiRef} editorOptions={{ clearOnSubmit: false }}
        onSubmit={submit} onSubmitWhileWorking={submit} onStop={() => store.stop()}
        onInputChange={text => store.setDraftText(text)}
        queuedPromptEdit={store.queuedPromptEdit}
        onBeginEditQueuedPrompt={id => { void store.beginQueuedPromptEdit(id); }}
        onChangeQueuedPromptEdit={text => store.changeQueuedPromptEdit(text)}
        onFinishQueuedPromptEdit={text => { void store.finishQueuedPromptEdit(text); }}
        onEditQueuedPrompt={(id, text) => { void store.editQueuedPrompt(id, text); }}
        onDeleteQueuedPrompt={id => store.deleteQueuedPrompt(id)}
        onReorderQueuedPrompts={ids => store.reorderQueuedPrompts(ids)}
        onSendQueuedPromptNow={id => store.sendQueuedPromptNow(id, { steers: false })} />
    </MessageProvider>;
  });
  composerRoot.render(<Compose />);
  await until('real prompt editor mounts', () => host.querySelector('[data-testid="prompt-editor"]') != null);

  const trace: Array<Record<string, unknown>> = [];
  let q: SessionInput | undefined;
  let qStarted = false;
  let nativeUserId = 'native-Q-user';
  let phase = direct ? 'first-same-text-input' : 'main';
  let frameSerial = 0;
  const runtimeQueueId = 'runtime-Q';
  function visible(element: Element): boolean {
    const rect = element.getBoundingClientRect(); const css = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && css.display !== 'none' && css.visibility !== 'hidden'
      && rect.bottom > 0 && rect.top < innerHeight;
  }
  let eventLabel = 'mounted-before-send';
  let recording = true;
  let rafToken = 0;
  const recordFrame = () => {
      const knownQ = q ?? own.rows[0] ?? received[0];
      const ids = knownQ ? [knownQ.id, runtimeQueueId, nativeUserId] : [];
      const body = [...host.querySelectorAll<HTMLElement>('[data-agent-conversation-message]')]
        .filter(el => ids.includes(el.dataset.agentConversationMessage!));
      const tray = [...host.querySelectorAll<HTMLElement>('[data-native-input-id]')]
        .filter(el => ids.includes(el.dataset.nativeInputId!));
      const band = [...host.querySelectorAll<HTMLElement>('[data-queued-prompt-id]')]
        .filter(el => ids.includes(el.dataset.queuedPromptId!));
      const geometry = (els: HTMLElement[]) => els.map(el => ({ id: el.dataset.agentConversationMessage ?? el.dataset.nativeInputId ?? el.dataset.queuedPromptId,
        visible: visible(el), rect: el.getBoundingClientRect().toJSON() }));
      const frame = { case: name, phase, label: eventLabel, frame: ++frameSerial, raf: performance.now(), qId: knownQ?.id ?? null, qStarted,
        bodyQ: body.filter(visible).length, queueQ: [...tray, ...band].filter(visible).length,
        body: geometry(body), tray: geometry(tray), band: geometry(band),
        outbox: own.rows.map(row => ({ id: row.id, queued: row.queued, baseline: row.baseline, afterTurnId: row.afterTurnId })),
        life: { version: sessionLifeView(sessionId)?.version, pending: sessionLifeView(sessionId)?.pending.items.map(row => ({ id: row.messageId, state: row.state })) },
        active: store.chatState.transcript.state.activeTurnSnapshot?.id ?? null,
        pending: store.chatState.session.state.pendingPrompt,
        transcriptPendingId: store.transcriptPendingId,
        runtimeQueue: store.queuedPrompts.map(row => row.id), committedIds: store.chatState.transcript.state.committedTurns.map(turn => turn.id) };
      trace.push(frame);
    if (recording) rafToken = requestAnimationFrame(recordFrame);
  };
  rafToken = requestAnimationFrame(recordFrame);
  cleanup.push(() => { recording = false; cancelAnimationFrame(rafToken); });
  async function paint(label: string) {
    eventLabel = label;
    // Measurement barriers only; a continuous recorder covers ALL RAFs, including screenshot/RPC gaps.
    // No product timer, suppressed frame, CSS hiding, fake timer or text-based matching is used.
    for (let step = 0; step < 2; step++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    // The continuous recorder includes every actual RAF; no sleep, hidden frame or screenshot barrier.
  }
  async function send() {
    eventLabel = 'editor-submit';
    const input = page.getByTestId('prompt-editor');
    await input.click(); await input.fill(sameText); await userEvent.keyboard('{Enter}');
    if (name === 'B-durable-first-frame') {
      await paint('persistence-not-committed');
      expect(own.rows).toEqual([]);
      expect(editorApiRef.current?.getText(), 'the draft stays visible while its durable row is not committed').toBe(sameText);
      expect(received).toEqual([]);
      releasePersistence();
    }
    await until('production outbox persists the input', () => own.rows.some(row => row.sessionId === sessionId));
    q = own.rows[0]; await refresh;
    if (!busy) await until('ordinary input reaches host RPC', () => received.length === 1);
    await paint('sender-enqueued');
  }
  async function lifeRow(state: 'queued' | 'accepted') {
    eventLabel = `life-${state}-inject`;
    life = { ...life, version: life.version + 1, pending: { count: 1, items: [{ seq: 1, messageId: q!.id,
      kind: 'session-direct', state, failure: null, preview: q!.text, text: q!.text }] } };
    // Actual production Life event handler is registered through onMachineEvent.
    for (const [channel, listeners] of events) if (channel.includes('life')) for (const listener of listeners) listener(life);
    await until('Life event version consumed', () => sessionLifeView(sessionId)?.version === life.version);
    await paint(`life-${state}`);
  }
  async function accept() {
    eventLabel = 'rpc-accept-inject';
    held.shift()!.accept();
    await until('host ack removes only sender custody', () => !own.rows.some(row => row.id === q!.id));
    await paint('rpc-accepted-queued');
  }
  async function queueEvent() {
    eventLabel = 'runtime-queue-inject';
    session.sessionState.set({ ...session.sessionState.current(), lifecycle: 'working', activeTurnId: foreground.id, isGenerating: true,
      queuedPrompts: [{ id: runtimeQueueId, clientMessageId: q!.id, text: q!.text, origin: 'manual', createdAt: Date.now(), updatedAt: Date.now(), attachments: [] }] } as never);
    await paint('runtime-queue-Q');
  }
  async function activeA() { eventLabel = 'active-A-inject'; session.activeTurn.set(foreground); await paint('active-A'); }
  async function nativeQ(turnId = 'native-Q-turn', itemId = 'native-Q-user') {
    eventLabel = 'native-Q-inject';
    qStarted = true; nativeUserId = itemId;
    // Native ID intentionally differs from client ID, as the unmodified d5 runtime does.
    const native = turn(turnId, itemId, q!.text);
    const user = native.items[0];
    if (user?.kind !== 'message' || user.role !== 'user') throw new Error('Fixture user message is missing');
    native.items[0] = { ...user, _meta: { guguClientMessageId: q!.id } };
    session.activeTurn.set({ ...native, seq: turnId === 'previous-same' ? 0 : 1, startedAt: q!.createdAt - 5_000 });
    session.sessionState.set({ ...session.sessionState.current(), lifecycle: 'working', activeTurnId: turnId, isGenerating: true, queuedPrompts: [] });
    await paint('native-Q-started');
  }
  if (direct) {
    // Generate the earlier same-text message through the SAME real editor/outbox, then commit it.
    // The second submit must exclude that first native ID from its new receipt baseline.
    await send(); await lifeRow('accepted'); await accept();
    await nativeQ('previous-same', 'previous-same:user');
    historyTurns = [{ ...session.activeTurn.current()!, endedAt: Date.now(), outcome: { kind: 'done' } }];
    eventLabel = 'first-turn-commit-inject';
    session.activeTurn.set(null); session.sessionState.set(readyState);
    await until('first real input is committed history', () => store.chatState.transcript.state.committedTurns.some(turn => turn.id === firstSame.id));
    await paint('first-turn-committed');
    life = { ...life, version: life.version + 1, pending: { count: 0, items: [] } };
    for (const [channel, listeners] of events) if (channel.includes('life')) for (const listener of listeners) listener(life);
    await paint('first-input-released');
    await queue.flush();
    trace.length = 0; received.length = 0; q = undefined; qStarted = false;
    phase = 'second-same-text-input'; nativeUserId = 'native-Q-user';
  }
  await send();
  if (direct) {
    expect(q!.queued).toBe(false);
    // Same text is already in baseline under a different ID. It must not consume this new pending row.
    expect(q!.baseline).toContain('previous-same:user');
    if (name === 'direct-ack-first') { await lifeRow('queued'); await accept(); await lifeRow('accepted'); await nativeQ(); }
    else { await nativeQ(); await lifeRow('accepted'); await accept(); }
  } else if (busy) {
    expect(q!.sendQueue).toBeDefined();
    expect(received).toEqual([]);
    const queuedFramesStart = trace.findIndex(frame => frame.qId && frame.queueQ === 1);
    const firstQueueRect = (trace[queuedFramesStart].band as Array<{ rect: { y: number } }>)[0].rect;
    if (name === 'B-active-first') await activeA();
    // Unrelated host updates must not reclassify a known-unsent local input.
    life = { ...life, version: life.version + 1, pending: { count: 0, items: [] } };
    for (const [channel, listeners] of events) if (channel.includes('life')) for (const listener of listeners) listener(life);
    await paint('unrelated-life-ready');
    if (name === 'B-life-first' || name === 'B-durable-first-frame') await activeA();
    await queue.flush(true); await paint('automatic-retry-does-not-send');
    const heldFrames = trace.slice(queuedFramesStart);
    expect(heldFrames.every(frame => frame.bodyQ === 0 && frame.queueQ === 1)).toBe(true);
    expect(heldFrames.every(frame => (frame.band as Array<{ rect: { y: number } }>)[0].rect.y === firstQueueRect.y)).toBe(true);
    expect(received).toEqual([]);
    if (name === 'B-mixed-legacy') {
      phase = 'legacy-upgrade-order';
      session.sessionState.set({ ...session.sessionState.current(), queuedPrompts: ['legacy-1', 'legacy-2'].map(id => ({
        id, text: id, origin: 'manual', createdAt: 1, updatedAt: 1, attachments: [],
      })) } as never);
      const editor = page.getByTestId('prompt-editor');
      await editor.fill('another local input'); await userEvent.keyboard('{Enter}');
      await until('second held input is visible', () => own.rows.length === 2 && store.queuedPrompts.length === 4);
      const second = own.rows.find(input => input.id !== q!.id)!;
      const queueRow = (id: string) => host.querySelector<HTMLElement>(`[data-queued-prompt-id="${id}"]`)!;
      const drag = async (from: string, to: string) => userEvent.dragAndDrop(queueRow(from).querySelector<HTMLButtonElement>('button[draggable]')!, queueRow(to));
      await drag('legacy-2', 'legacy-1');
      await until('legacy reorder reaches its original host API', () => session.changeQueuePromptOrder.mock.calls.length === 1);
      expect(session.changeQueuePromptOrder).toHaveBeenCalledWith(['legacy-2', 'legacy-1']);
      await drag(second.id, q!.id);
      const expected = ['legacy-2', 'legacy-1', second.id, q!.id];
      await until('local reorder persists alongside legacy rows', () => store.queuedPrompts.map(input => input.id).join() === expected.join());
      expect(session.changeQueuePromptOrder).toHaveBeenCalledTimes(1);
      const toasts = hostRpc.toast.mock.calls.length;
      await drag(q!.id, 'legacy-1'); await paint('cross-owner-drop-returns-to-original-slot');
      expect(store.queuedPrompts.map(input => input.id)).toEqual(expected);
      expect(session.changeQueuePromptOrder).toHaveBeenCalledTimes(1);
      expect(hostRpc.toast.mock.calls.length).toBe(toasts);
      expect(received).toEqual([]);
      recording = false; cancelAnimationFrame(rafToken);
      return;
    }
    let sentNow = false;
    if (name === 'B-life-first') {
      phase = 'queue-actions';
      const input = page.getByTestId('prompt-editor');
      for (const text of ['second queued', 'third queued']) {
        await input.fill(text); await userEvent.keyboard('{Enter}');
        await until('additional input persists in send queue', () => own.rows.some(row => row.text === text));
      }
      const second = own.rows.find(row => row.text === 'second queued')!;
      const third = own.rows.find(row => row.text === 'third queued')!;
      const queueRow = (id: string) => host.querySelector<HTMLElement>(`[data-queued-prompt-id="${id}"]`)!;
      const action = (id: string, title: string) => [...queueRow(id).querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.title === title)!;
      const t = i18n.getFixedT('zh-CN', 'session');
      await input.fill('保留的草稿');
      const edit = [...queueRow(q!.id).querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.getAttribute('aria-label')?.startsWith('编辑'))!;
      await userEvent.click(edit);
      await until('edit reserves the persistent entry', () => !!own.rows.find(row => row.id === q!.id)?.sendQueue?.edit);
      // The reservation can publish before the store clears pending, while the composer still drops edits.
      // Wait for the rendered editor to accept input before selecting through its keymap.
      await until('the composer has opened the entry for editing', () => {
        const cancel = [...view.composerSlot!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === t('common.cancel'));
        const editor = input.element();
        return !!cancel && !cancel.disabled && editor.getAttribute('aria-disabled') === 'false' && document.activeElement === editor
          && editorApiRef.current?.getText() === q!.text && !store.queuedPromptEdit?.pending;
      });
      // fill() selects only the DOM; deferred focus reconciliation can restore the model's old caret.
      // Mod-a updates ProseMirror's selection too, so subsequent focus work preserves the replacement.
      await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}');
      await userEvent.keyboard('edited queued input');
      await until('the queued editor and its controlled state contain the edit', () => editorApiRef.current?.getText() === 'edited queued input'
        && store.queuedPromptEdit?.text === 'edited queued input' && !store.queuedPromptEdit.pending);
      await userEvent.keyboard('{Enter}');
      await until('the same queued identity has the saved text', () => ({
        row: own.rows.find(row => row.id === q!.id), editor: editorApiRef.current?.getText(), edit: store.queuedPromptEdit,
      }), ({ row }) => row?.text === 'edited queued input' && !row.sendQueue?.edit);
      expect(store.draftText).toBe('保留的草稿');
      q = own.rows.find(row => row.id === q!.id)!;
      await userEvent.dragAndDrop(queueRow(third.id).querySelector<HTMLButtonElement>('button[draggable]')!, queueRow(second.id));
      await until('drag changes the persistent order', () => [...own.rows].filter(row => row.sendQueue)
        .sort((a, b) => a.sendQueue!.order - b.sendQueue!.order).map(row => row.id).join() === [q!.id, third.id, second.id].join());
      await userEvent.click(action(second.id, t('composer.deleteQueuedPrompt')));
      await until('delete removes only the selected persistent input', () => !own.rows.some(row => row.id === second.id));
      expect(received).toEqual([]);
      await userEvent.click(action(q.id, t('composer.sendNowCancelsTurn')));
      await until('send now reaches the real custody RPC', () => received.some(row => row.id === q!.id));
      expect(session.cancelTurn).toHaveBeenCalledTimes(1);
      expect(own.rows.some(row => row.id === third.id && row.sendQueue)).toBe(true);
      sentNow = true;
    }
    historyTurns = [{ ...foreground, outcome: { kind: 'done' }, endedAt: Date.now() }];
    session.activeTurn.set(null); session.sessionState.set(readyState);
    await until('foreground completion is in real history', () => store.chatState.transcript.state.committedTurns.some(turn => turn.id === foreground.id));
    if (!sentNow) await releaseQueuedSessionInput(sessionId, historyTurns);
    await until('the idle boundary sends exactly this input', () => received.length === 1);
    await paint('actually-sent');
    await lifeRow('queued'); await accept(); await queueEvent(); await lifeRow('accepted'); await nativeQ();
  } else {
    expect(q!.queued).toBe(false);
    if (name === 'A-active-first') await activeA();
    await lifeRow('queued');
    if (name === 'A-queue-first') { await queueEvent(); await activeA(); }
    else await queueEvent();
    await accept(); await lifeRow('accepted'); await nativeQ();
  }
  recording = false; cancelAnimationFrame(rafToken);
  const preStart = trace.filter(frame => !frame.qStarted && frame.qId);
  if (busy) {
    const first = trace.findIndex(frame => frame.queueQ === 1);
    expect(trace.slice(first).every(frame => Number(frame.bodyQ) + Number(frame.queueQ) === 1),
      'composer release and transcript mount have one visible owner on every frame').toBe(true);
  }
  const violations = busy ? [] : preStart.slice(preStart.findIndex(frame => frame.bodyQ === 1)).filter(frame => frame.bodyQ !== 1 || frame.queueQ !== 0);
  expect(trace.at(-1)?.bodyQ, 'one native message after Q starts').toBe(1);
  expect(trace.at(-1)?.queueQ, 'no queue copy after Q starts').toBe(0);
  if (direct) {
    const firstVisible = preStart.findIndex(frame => frame.bodyQ === 1);
    expect(firstVisible, 'ordinary placeholder is drawn before any host event').toBeGreaterThanOrEqual(0);
    expect(preStart.slice(firstVisible).every(frame => frame.bodyQ === 1 && frame.queueQ === 0), 'ordinary row stays in body from its first visible frame until native turn').toBe(true);
    const before = preStart[firstVisible].body as Array<{ rect: { x: number; y: number } }>;
    const after = trace.at(-1)!.body as Array<{ rect: { x: number; y: number } }>;
    expect({ x: after[0].rect.x, y: after[0].rect.y }, 'ordinary native takeover preserves the row position').toEqual({ x: before[0].rect.x, y: before[0].rect.y });
    expect(store.chatState.session.state.pendingPrompt, 'native echo consumes the ordinary placeholder').toBeNull();
  } else {
    expect(violations, 'an already-sent input never becomes a composer queue entry').toEqual([]);
  }
});
