// @vitest-environment jsdom
// #1344 — incoming rows that are still unresolved.
import { afterEach, expect, it, vi } from 'vitest';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { LifeView } from '@shared/core/sessions/session-life';
import { installAcpChatStoreHost } from './acp-chat-store.test-host';
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));
installAcpChatStoreHost();
const { AcpChatStore } = await import('./acp-chat-store');
const stores: InstanceType<typeof AcpChatStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); });
it('projects unknown incoming rows into the transcript without synthetic failed/queued turns or reaction churn', () => {
  const store = new AcpChatStore('incoming-1344', 'project'); stores.push(store);
  const input = { seq: 1, messageId: 'source-id', kind: 'session-direct' as const, state: 'unknown' as const, failure: null, preview: 'incoming',
    text: renderDeliveryEnvelope({ route: 'session-direct', from: 'Sender', fromId: 'session:sender', messageId: 'msg:source-id', at: 'now', content: 'incoming' }) };
  const view: LifeView = { sessionId: store.sessionId, version: 1, kind: 'ready', stage: null, hold: null, failure: null, lastExit: null, nativeSession: null, pending: { count: 1, items: [input] } };
  const internals = store as unknown as { _incomingHistoryResolved: Set<string>; _drawLifeHead(view: LifeView): void };
  internals._drawLifeHead(view);
  expect(store.chatState.session.state.pendingMessages).toHaveLength(0);
  internals._incomingHistoryResolved.add(input.messageId);
  internals._drawLifeHead(view);
  expect(store.chatState.session.state.pendingMessages).toMatchObject([{ id: input.messageId, text: input.text, delivery: { state: 'unknown', retryable: false } }]);
  expect(store.chatState.session.state.pendingPrompt).toBeNull();
  expect(store.chatState.transcript.state.committedTurns).toHaveLength(0);
  const revision = store.transcriptRevision;
  for (let index = 0; index < 20; index++) internals._drawLifeHead(view);
  expect(store.transcriptRevision).toBe(revision);
  store.chatState.transcript.history.seed([{ id: 'native', seq: 0, initiator: 'agent', items: [{ kind: 'message', id: 'native-echo', seq: 0, role: 'user', text: input.text }] }]);
  internals._drawLifeHead(view);
  expect(store.chatState.session.state.pendingMessages).toHaveLength(1);
  expect(store.chatState.transcript.state.committedTurns).toHaveLength(1);
  internals._drawLifeHead({ ...view, version: 2, pending: { count: 0, items: [] } });
  expect(store.chatState.session.state.pendingMessages).toHaveLength(0);
});
