// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));
const read = vi.fn();
Object.defineProperty(document, 'fonts', { configurable: true, value: { load: vi.fn().mockResolvedValue([]) } });
Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
  invoke: (channel: string, input: unknown) => channel === 'sessions.getStoredHistory' ? read(input) : Promise.resolve([]),
  eventSend: () => {}, eventOn: () => () => {}, getPathForFile: () => '',
} });
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
