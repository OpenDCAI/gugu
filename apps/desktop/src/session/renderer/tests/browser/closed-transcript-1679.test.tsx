import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { runInAction } from 'mobx';
import { createChatView, type TranscriptTurn } from '@gugu/session-chat-ui';
import { i18n, setLocalePreference } from '@/i18n';
import { registerSessionLocaleResources } from '@renderer/localization/locale-store';
import { renumberStoredTurn } from '@main/core/sessions/session-turn-identity';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';

vi.mock('@renderer/lib/acp/runtime-client', () => ({ getAcpRuntimeClient: async () => ({ getStoredQueue: async () => [] }) }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));
const listeners = new Map<string, Set<(data: unknown) => void>>();
let persisted: { originTurnId: string; turn: TranscriptTurn } | null = null;
Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
  invoke: async (channel: string) => channel.includes('getStoredSettledTurn') ? persisted : [],
  eventSend() {}, getPathForFile: () => '',
  eventOn: (channel: string, callback: (data: unknown) => void) => {
    const set = listeners.get(channel) ?? new Set(); listeners.set(channel, set); set.add(callback);
    return () => set.delete(callback);
  },
} });
const { AcpChatStore } = await import('@renderer/features/sessions/acp/acp-chat-store');
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); persisted = null; });
function replica<T>(initial: T) {
  let value = initial; const callbacks = new Set<(next: T) => void>();
  return { current: () => value, onChange: (callback: (next: T) => void) => {
    callbacks.add(callback); return () => callbacks.delete(callback);
  }, onGone: () => () => {}, push: (next: T) => {
    value = next; for (const cb of [...callbacks]) cb(next);
  } };
}

it.each(['closed-first', 'active-null-first', 'late-persistence'] as const)('%s: the real store and transcript replace working with one factual Stopped', async order => {
  await page.viewport(1000, 800);
  setLocalePreference('en-US'); await i18n.changeLanguage('en-US'); registerSessionLocaleResources();
  const id = 'browser-close-' + crypto.randomUUID();
  const live: TranscriptTurn = { id: id + ':turn:0', referenceId: 'source:' + crypto.randomUUID(), seq: 0,
    initiator: 'user', startedAt: Date.now() - 2000, items: [
      { kind: 'message', id: id + ':turn:0:user', seq: 0, role: 'user', text: 'Keep this original request' },
      { kind: 'unknown-tool-call', id: id + ':turn:0:tool', seq: 1, toolCallId: 'tool', title: 'Bash', name: 'Bash', toolKind: 'execute', status: 'running' },
    ] };
  const ready = { lifecycle: 'working', activeTurnId: live.id as string | null, queuedPrompts: [], pendingPermissions: [],
    isGenerating: true, backgroundAgentCount: 0, backgroundCommandCount: 0, lastTurnOutcome: 'none', lastStopReason: null };
  const session = {
    activeTurn: replica<TranscriptTurn | null>(live), sessionState: replica(ready), agents: replica([]), config: replica({}),
    plan: replica(null), terminals: replica([]), draft: replica(null), onDraftSyncReady: () => () => {},
    canSyncDraft: () => false, dispose() {}, getHistory: async () => ({ success: true, data: { turns: [], count: 0, cursor: { epoch: 'removed', seq: 0 } } }),
  };
  const store = new AcpChatStore(id, 'project');
  const internal = store as unknown as { _bootstrapped: boolean; _subscribeLiveSession: (session: unknown) => void };
  runInAction(() => { internal._bootstrapped = true; store.historyLoading = false;
    store.session = session as unknown as typeof store.session; internal._subscribeLiveSession(session); });
  cleanup.push(() => store.dispose());
  const host = document.createElement('div'); host.className = 'gugu-skin emlight';
  host.style.cssText = 'position:fixed;inset:0;width:1000px;height:800px'; document.body.append(host);
  const view = createChatView({ parent: host, context: store.chatContext, state: store.chatState, composer: 'slot' });
  store.chatContext.setLayout({ preset: 'double', userGutter: 0, agentConversation: true });
  cleanup.push(() => { view.dispose(); host.remove(); });
  await until('the actual working process is visible', () => host.textContent?.includes('Thinking and working') === true);
  // Count rendered cards, not the screen-reader text mirror inside each card.
  const promptCards = () => [...host.querySelectorAll('[data-user-card]')]
    .filter(card => card.textContent?.includes('Keep this original request')).length;
  expect(promptCards()).toBe(1);
  const finish = () => {
    const turn = renumberStoredTurn({ ...live, outcome: { kind: 'cancelled', reason: 'cancelled' },
      items: live.items.map(item => item.kind === 'unknown-tool-call' ? { ...item, status: 'error' as const } : item) }, id, 0);
    persisted = { originTurnId: live.id, turn };
    for (const callback of listeners.get('session:turn-settled') ?? []) callback({ sessionId: id, referenceId: live.referenceId, status: 'persisted' });
  };
  if (order !== 'late-persistence') finish();
  if (order === 'active-null-first') session.activeTurn.push(null);
  session.sessionState.push({ ...ready, lifecycle: 'closed', activeTurnId: null, isGenerating: false } as typeof ready);
  session.activeTurn.push(null);
  const frames: number[] = [];
  for (let frame = 0; frame < 8; frame++) {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    frames.push(promptCards());
    if (frame === 2 && order === 'late-persistence') finish();
  }
  await until('actual terminal outcome renders', () => host.textContent?.includes('Stopped') === true);
  expect(host.textContent).not.toContain('Thinking and working');
  expect(frames).toEqual(Array(8).fill(1));
  expect(store.chatState.transcript.state.committedTurns).toHaveLength(1);
  expect(store.chatState.transcript.state.committedTurns[0]?.outcome?.kind).toBe('cancelled');
});
