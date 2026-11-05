// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import { installAcpChatStoreHost } from './acp-chat-store.test-host';
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));
const read = vi.fn();
installAcpChatStoreHost((channel: string, input: unknown) => channel === 'sessions.getStoredHistory' ? read(input) : Promise.resolve([]));
const { AcpChatStore } = await import('./acp-chat-store');
const runtime: TranscriptTurn = { id: 'runtime', seq: 0, initiator: 'user', startedAt: 100, items: [
  { kind: 'message', id: 'input', seq: 0, role: 'user', text: 'Work', at: 100 },
] };
const notice: TranscriptTurn = { id: 's:turn:s0', seq: 0, initiator: 'agent', startedAt: 200, items: [
  { kind: 'message', id: 's:turn:s0:message:notice', seq: 0, role: 'assistant', text: 'Review', at: 200,
    ownerNotification: { requestId: '11111111-1111-4111-8111-111111111111', requestHash: 'hash', sourceTurnId: 'runtime' } },
] };
type Internals = { session: { activeTurn: { current(): TranscriptTurn } } | null; _historyGeneration: number;
  _storedHistoryTurns: TranscriptTurn[]; _storedOrigins: string[]; _ownerNotificationListeners: Set<() => void>;
  _storedBootstrapMaxSeq: number; _storedBaseSeq: number | null; _ownerNotificationReadSeq: number; _ownerNotificationGeneration: number;
  _storedHistoryEpoch: number; _loadStoredFirstPage(generation: number): Promise<void>;
  _ownerNotificationTurns: TranscriptTurn[]; _resetHistoryState(): void;
  _ownerNotificationView(): { turns: TranscriptTurn[]; activeTurn: TranscriptTurn | null } };
const stores: InstanceType<typeof AcpChatStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) { (store as unknown as Internals).session = null; store.dispose(); } read.mockReset(); });

it('patches the current active view immediately after the host commit without reopening or prompting the provider', async () => {
  const store = new AcpChatStore('s', 'p'); stores.push(store);
  const internal = store as unknown as Internals;
  internal.session = { activeTurn: { current: () => runtime } };
  const changed = vi.fn(); internal._ownerNotificationListeners.add(changed);
  read.mockResolvedValue({ turns: [notice], originTurnIds: ['owner-notify:request'], nextCursor: null });
  await store.syncOwnerNotifications(0);
  expect(store.chatState.transcript.state.activeTurnSnapshot!.items.at(-1)!.id).toBe(notice.items[0]!.id);
  expect(internal._ownerNotificationView().activeTurn!.items.at(-1)!.id).toBe(notice.items[0]!.id);
  expect(changed).toHaveBeenCalledOnce();
  await store.syncOwnerNotifications(0);
  expect(read).toHaveBeenCalledOnce();
  internal.session = null;
  internal._storedHistoryTurns = [{ ...runtime, id: 's:turn:s1', seq: 1 }]; internal._storedOrigins = ['runtime'];
  const committed = internal._ownerNotificationView().turns;
  expect(committed).toHaveLength(1);
  expect(committed[0]!.items.at(-1)!.id).toBe(notice.items[0]!.id);
  expect(runtime.items).toHaveLength(1);
});

it('retries a notification read interrupted by bootstrap instead of consuming its head without showing it', async () => {
  const store = new AcpChatStore('s', 'p'); stores.push(store);
  const internal = store as unknown as Internals;
  read.mockImplementationOnce(async () => { internal._historyGeneration++; return { turns: [notice] }; })
    .mockResolvedValue({ turns: [notice] });
  await store.syncOwnerNotifications(0);
  expect(read).toHaveBeenCalledTimes(2);
  expect(store.chatState.transcript.state.committedTurns[0]!.items[0]!.id).toBe(notice.items[0]!.id);
});

it('keeps notifications outside the loaded page out of the tail and merges new commits in stored order', async () => {
  const store = new AcpChatStore('s', 'p'); stores.push(store);
  const internal = store as unknown as Internals;
  const recent = { ...runtime, id: 's:turn:s200', seq: 200, items: [{ ...runtime.items[0]!, id: 'input-200' }] };
  internal._storedHistoryTurns = [recent]; internal._storedOrigins = ['provider-recent'];
  internal._storedBaseSeq = 200; internal._storedBootstrapMaxSeq = 200;
  await store.syncOwnerNotifications(0);
  expect(read).not.toHaveBeenCalled();
  expect(internal._ownerNotificationView().turns).toEqual([recent]);
  const newNotice = { ...notice, id: 's:turn:s201', seq: 201, items: [{ ...notice.items[0]!, ownerNotification: { requestId: 'new', requestHash: 'hash' } }] } as TranscriptTurn;
  internal._storedHistoryTurns.push({ ...runtime, id: 's:turn:s202', seq: 202, items: [{ ...runtime.items[0]!, id: 'input-202' }] });
  read.mockResolvedValue({ turns: [newNotice] });
  await store.syncOwnerNotifications(201);
  expect(read).toHaveBeenCalledWith({ sessionId: 's', fromSeq: 201, ownerNotificationsOnly: true });
  expect(internal._ownerNotificationView().turns.map(turn => turn.seq)).toEqual([200, 201, 202]);
});

it.each([0, 2])('drops an in-flight old epoch and reads a reused head %i after a revert', async (replacementSeq) => {
  const store = new AcpChatStore('s', 'p'); stores.push(store);
  const internal = store as unknown as Internals;
  const notification = (seq: number, requestId: string): TranscriptTurn => ({ ...notice, id: `s:turn:s${seq}`, seq,
    items: [{ ...notice.items[0]!, id: requestId, ownerNotification: { requestId, requestHash: requestId } }] } as TranscriptTurn);
  read.mockResolvedValueOnce({ turns: [notification(2, 'old')] });
  await store.syncOwnerNotifications(2, 0);
  let finishOld!: (page: unknown) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const oldRequest = store.syncOwnerNotifications(3, 0);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  read.mockResolvedValueOnce({ turns: [notification(replacementSeq, 'replacement')], originTurnIds: ['owner-notify:replacement'], nextCursor: null });
  const reverted = store.syncOwnerNotifications(replacementSeq, 1);
  finishOld({ turns: [notification(3, 'stale-in-flight')] });
  await Promise.all([oldRequest, reverted]);
  expect(internal._ownerNotificationView().turns.flatMap(turn => turn.items.map(item => item.id))).toEqual(['replacement']);
  expect(internal._ownerNotificationReadSeq).toBe(replacementSeq);
  read.mockResolvedValueOnce({ turns: [notification(replacementSeq + 1, 'after-revert')] });
  await store.syncOwnerNotifications(replacementSeq + 1, 1);
  expect(read).toHaveBeenLastCalledWith({ sessionId: 's', fromSeq: replacementSeq + 1, ownerNotificationsOnly: true });
  expect(internal._ownerNotificationView().turns.map(turn => turn.seq)).toEqual([replacementSeq, replacementSeq + 1]);
  const generation = internal._ownerNotificationGeneration;
  internal._resetHistoryState();
  expect(internal._ownerNotificationReadSeq).toBe(-1);
  expect(internal._ownerNotificationTurns).toEqual([]);
  expect(internal._ownerNotificationGeneration).toBeGreaterThan(generation);
});

it('invalidates a bootstrap page reverted before the first notification subscription, including an empty replacement', async () => {
  const store = new AcpChatStore('s', 'p'); stores.push(store);
  const internal = store as unknown as Internals;
  const deleted = { ...runtime, id: 's:turn:s5', seq: 5 };
  read.mockResolvedValueOnce({ turns: [deleted], originTurnIds: ['deleted'], nextCursor: null, nativeOwnerNotificationEpoch: 0 });
  await internal._loadStoredFirstPage(internal._historyGeneration);
  expect(internal._storedBootstrapMaxSeq).toBe(5);
  read.mockResolvedValueOnce({ turns: [], originTurnIds: [], nextCursor: null, nativeOwnerNotificationEpoch: 1 });
  await store.syncOwnerNotifications(-1, 1);
  expect(internal._ownerNotificationView().turns).toEqual([]);
  expect(internal._storedBootstrapMaxSeq).toBe(-1);
  expect(internal._storedHistoryEpoch).toBe(1);
  read.mockResolvedValueOnce({ turns: [notice], nativeOwnerNotificationEpoch: 1 });
  await store.syncOwnerNotifications(0, 1);
  expect(read).toHaveBeenLastCalledWith({ sessionId: 's', fromSeq: 0, ownerNotificationsOnly: true });
  expect(internal._ownerNotificationView().turns).toEqual([notice]);
});

it('keeps a bootstrap window already read in the first subscribed epoch', async () => {
  const store = new AcpChatStore('s', 'p'); stores.push(store);
  const internal = store as unknown as Internals;
  read.mockResolvedValueOnce({ turns: [notice], originTurnIds: ['owner-notify:request'], nextCursor: null, nativeOwnerNotificationEpoch: 1 });
  await internal._loadStoredFirstPage(internal._historyGeneration);
  await store.syncOwnerNotifications(0, 1);
  expect(read).toHaveBeenCalledOnce();
  expect(internal._ownerNotificationView().turns).toEqual([notice]);
});
