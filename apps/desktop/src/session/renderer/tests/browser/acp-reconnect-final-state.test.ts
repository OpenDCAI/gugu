import { afterEach, expect, it, vi } from 'vitest';
import { createChatContext, createChatState, createChatView, connectSession, type TranscriptTurn } from '@gugu/session-chat-ui';
import { domPortTransport, serve } from '@gugu/session-wire';
import { AcpLiveSession, asValueSource } from '@renderer/lib/acp/acp-live-session';
import { resetAcpRuntimeClient } from '@renderer/lib/acp/runtime-client';
import { until } from '../../../../../../../tests/support/awaitCondition';

const bridge = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@renderer/lib/electron-api', () => ({ electronApi: () => ({ requestWirePort: bridge.request }) }));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));
vi.mock('@renderer/lib/machine-clients', () => ({ machineWireTransport: () => { throw new Error('Local session uses a MessagePort'); } }));

const cleanup: Array<() => void> = [];
afterEach(() => {
  resetAcpRuntimeClient();
  for (const close of cleanup.splice(0).reverse()) close();
});

it('removes every streaming cursor and running label after a turn finishes while its state connection is down', async () => {
  const turn: TranscriptTurn = { id: 'completed-offline', seq: 0, initiator: 'user', startedAt: Date.now() - 14_000,
    items: [
      { kind: 'message', id: 'question', seq: 0, role: 'user', text: 'Check the result.' },
      { kind: 'message', id: 'answer', seq: 1, role: 'assistant', text: 'The work is complete.\n\nThe final paragraph.' },
    ] };
  const completed: TranscriptTurn = { ...turn, endedAt: Date.now(), outcome: { kind: 'done', reason: 'end_turn' } };
  const ready = { lifecycle: 'ready', activeTurnId: null, pendingPermissions: [], lastStopReason: 'end_turn', lastTurnOutcome: 'stopped',
    queuedPrompts: [], backgroundAgentCount: 0, backgroundCommandCount: 0, isGenerating: false, canSubmit: true, canCancel: false };
  const data: Record<string, unknown> = {
    state: { ...ready, lifecycle: 'working', activeTurnId: turn.id, lastStopReason: null, lastTurnOutcome: 'none', isGenerating: true, canSubmit: false, canCancel: true },
    activeTurn: turn,
    config: { modelOptions: null, efforts: null, modeOptions: null, availableCommands: [], acceptsImagePrompts: false },
    usage: null, plan: null, draft: null, agents: [], terminals: [],
  };
  let port: MessagePort;
  let opens = 0;
  bridge.request.mockImplementation(async () => {
    const { port1, port2 } = new MessageChannel();
    port = port1;
    opens++;
    const stop = serve(domPortTransport(port2), {
      call: async (path) => {
        expect(path).toBe('getHistory');
        return { success: true, data: { turns: [completed], nextCursor: null, count: 1, cursor: { epoch: 'runtime', seq: 1 }, reset: false } };
      },
      resolveLive: topic => ({
        snapshot: () => ({ generation: opens, sequence: 0, timestamp: Date.now(), data: data[topic.split('|')[0].split('.').at(-1)!] }),
        subscribe: () => () => {},
      }),
    });
    cleanup.push(() => { stop(); port1.close(); port2.close(); });
    window.dispatchEvent(new MessageEvent('message', { data: { kind: 'acp-wire:port' }, ports: [port1] }));
  });
  const session = await AcpLiveSession.create('offline-session');
  cleanup.push(() => session.dispose());
  const context = createChatContext({ locale: () => 'en-US' });
  context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:800px;height:700px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host });
  cleanup.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  let reconciliations = 0;
  const disconnect = connectSession(state, {
    activeTurn: asValueSource(session.activeTurn), plan: asValueSource(session.plan), sessionState: asValueSource(session.sessionState),
  }, {
    onTurnCommitted: () => {
      reconciliations++;
      void session.getHistory().then(result => {
        if (!result.success) throw new Error('Expected authoritative history');
        state.transcript.history.seed(result.data.turns);
      });
    },
  });
  cleanup.push(disconnect);
  const visibleCarets = () => [...host.querySelectorAll('[data-conversation-caret="true"] p:last-child')]
    .filter(element => getComputedStyle(element, '::after').content.includes('▍') && getComputedStyle(element, '::after').animationName !== 'none');
  await until('both running paragraphs render their real animated carets', () => visibleCarets().length === 2);
  expect(host.querySelector('[data-conversation-process]')?.textContent).toContain('Thinking and working');
  expect(state.session.state.generating).toBe(true);

  // Nothing is delivered through the old port. The backend commits the turn before the replacement port is acquired.
  port!.close();
  data.state = ready;
  data.activeTurn = null;
  // Electron MessagePort emits close; standard browser ports need that platform event supplied by this bridge fixture.
  port!.dispatchEvent(new Event('close'));
  await vi.waitFor(() => expect(visibleCarets(), 'finished text must not retain either animated cursor').toHaveLength(0));
  await until('completed history replaces the retained live frame', () => state.transcript.state.committedTurns.length === 1);
  await until('all streaming carets and the running header disappear', () => host.querySelectorAll('[data-conversation-caret="true"]').length === 0
    && !host.querySelector('[data-conversation-process]')?.textContent?.includes('Thinking and working'));
  expect(opens).toBe(2);
  expect(reconciliations).toBe(1);
  expect(state.session.state.generating).toBe(false);
  expect(state.transcript.state.activeTurnSnapshot).toBeNull();
  expect(visibleCarets()).toHaveLength(0);
  expect(host.textContent).toContain('The work is complete.');
  expect(host.textContent).toContain('The final paragraph.');
});
