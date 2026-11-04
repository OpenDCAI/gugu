import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { domPortTransport, serve, WireError, type DomPortLike } from '@gugu/session-wire';
import { AcpLiveSession } from './acp-live-session';
import { attachInCurrentConnection } from './session-attachment';
import type { LifeView } from '@shared/core/sessions/session-life';
import { getAcpRuntimeClient, resetAcpRuntimeClient } from './runtime-client';

vi.setConfig({ testTimeout: 5_000 });

const bridge = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../electron-api', () => ({ electronApi: () => ({ requestWirePort: bridge.request }) }));
vi.mock('../machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));
vi.mock('../machine-clients', () => ({ machineWireTransport: () => { throw new Error('Local ACP uses its MessagePort'); } }));

const cleanup: Array<() => void> = [];
afterEach(() => {
  resetAcpRuntimeClient();
  for (const close of cleanup.splice(0)) close();
  vi.unstubAllGlobals();
});

function runtimePorts() {
  const listeners = new Set<(event: { data: unknown; ports: unknown[] }) => void>();
  vi.stubGlobal('window', {
    addEventListener: (_name: string, listener: (event: { data: unknown; ports: unknown[] }) => void) => listeners.add(listener),
    removeEventListener: (_name: string, listener: (event: { data: unknown; ports: unknown[] }) => void) => listeners.delete(listener),
  });
  let renderer: MessagePort | undefined;
  let current: Record<string, unknown> = {
    state: { lifecycle: 'working', activeTurnId: 'turn-1', pendingPermissions: [], lastStopReason: null,
      lastTurnOutcome: 'none', queuedPrompts: [], backgroundAgentCount: 0, backgroundCommandCount: 0,
      isGenerating: true, canSubmit: false, canCancel: true },
    activeTurn: { id: 'turn-1', seq: 0, initiator: 'user', items: [
      { kind: 'message', id: 'reply-1', seq: 0, role: 'assistant', text: 'The first paragraph.' },
      { kind: 'message', id: 'reply-2', seq: 1, role: 'assistant', text: 'The final paragraph.' },
    ] },
    config: { modelOptions: null, efforts: null, modeOptions: null, availableCommands: [], acceptsImagePrompts: false },
    usage: null, plan: null, draft: null, agents: [], terminals: [],
  };
  const command = vi.fn(() => new Promise<never>(() => {}));
  const held = new Map<string, Promise<void>>();
  let opens = 0;
  let available = true;
  const reads: Array<{ generation: number; available: boolean }> = [];
  bridge.request.mockImplementation(async () => {
    const { port1, port2 } = new MessageChannel();
    renderer = port1;
    opens++;
    const stop = serve(domPortTransport(port2 as unknown as DomPortLike), {
      call: command,
      resolveLive: topic => ({
        snapshot: async () => {
          reads.push({ generation: opens, available });
          if (!available) throw new WireError('NOT_FOUND', 'No session instance');
          const name = topic.split('|')[0].split('.').at(-1)!;
          await held.get(name);
          return { generation: opens, sequence: 0, timestamp: Date.now(), data: current[name] };
        },
        subscribe: () => () => {},
      }),
    });
    cleanup.push(() => { stop(); port1.close(); port2.close(); });
    for (const listener of [...listeners]) listener({ data: { kind: 'acp-wire:port' }, ports: [port1] });
  });
  return {
    command, reads,
    restartWithoutSession() { available = false; renderer!.close(); },
    restoreSession() { available = true; },
    hold(name: string) {
      let release!: () => void;
      held.set(name, new Promise<void>(resolve => { release = resolve; }));
      return release;
    },
    get opens() { return opens; },
    finishWhileDisconnected() {
      current = { ...current, state: { ...current.state as object, lifecycle: 'ready', activeTurnId: null,
        lastStopReason: 'end_turn', lastTurnOutcome: 'stopped', isGenerating: false, canSubmit: true, canCancel: false }, activeTurn: null };
      renderer!.close();
    },
  };
}

it.each(['state', 'draft'])('allows draft synchronization only after both reconnect snapshots arrive (%s last)', async last => {
  const runtime = runtimePorts();
  const session = await AcpLiveSession.create('draft-connection');
  cleanup.push(() => session.dispose());
  expect(session.canSyncDraft()).toBe(true);
  const ready = vi.fn();
  session.onDraftSyncReady(ready);
  const release = runtime.hold(last);
  runtime.finishWhileDisconnected();
  await vi.waitFor(() => expect(session.draftConnectionGeneration).toBe(1));
  await vi.waitFor(() => expect(runtime.opens).toBe(2));
  expect(session.canSyncDraft()).toBe(false);
  expect(ready).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() => expect(session.canSyncDraft()).toBe(true));
  expect(ready).toHaveBeenCalledTimes(1);
});

it('reopens the local state port and replaces both stale streaming messages with the authoritative completed turn', async () => {
  const runtime = runtimePorts();
  const session = await AcpLiveSession.create('local-completed');
  cleanup.push(() => session.dispose());
  expect(session.sessionState.current().isGenerating).toBe(true);
  expect(session.activeTurn.current()?.items).toHaveLength(2);
  runtime.finishWhileDisconnected();
  await vi.waitFor(() => {
    expect(runtime.opens, 'a closed local port must be reacquired without a user retry').toBe(2);
    expect(session.sessionState.current()).toMatchObject({ lifecycle: 'ready', isGenerating: false, activeTurnId: null });
    expect(session.activeTurn.current()).toBeNull();
  });
});

it('does not replay an engine command whose result was interrupted by the state-port disconnect', async () => {
  const runtime = runtimePorts();
  const session = await AcpLiveSession.create('local-command');
  cleanup.push(() => session.dispose());
  const client = await getAcpRuntimeClient();
  const result = client.cancelTurn({ sessionId: 'local-command' }).catch(error => error);
  await vi.waitFor(() => expect(runtime.command).toHaveBeenCalledOnce());
  runtime.finishWhileDisconnected();
  expect(await result).toMatchObject({ code: 'DISCONNECTED' });
  await vi.waitFor(() => expect(session.sessionState.current().isGenerating).toBe(false));
  expect(runtime.command).toHaveBeenCalledOnce();
});

it('preserves a real initial runtime-start error instead of converting it into an endless attachment wait', async () => {
  runtimePorts();
  const failure = new Error('Runtime executable could not start');
  bridge.request.mockRejectedValueOnce(failure);
  await expect(getAcpRuntimeClient()).rejects.toBe(failure);
});


it('abandons an initial MessagePort attachment on disconnect and waits for the restarted host ready before any snapshot', async () => {
  const runtime = runtimePorts();
  const release = runtime.hold('agents');
  const client = await getAcpRuntimeClient();
  let view: LifeView = { sessionId: 'initial-ready', kind: 'ready', version: 9, stage: null,
    pending: { count: 0, items: [] }, hold: null, failure: null, lastExit: null, nativeSession: null };
  const listeners = new Set<(value: LifeView) => void>();
  const readLife = vi.fn(async () => view);
  const attach = vi.fn(() => AcpLiveSession.create('initial-ready'));
  const pending = attachInCurrentConnection({ connection: client.connection, readLife,
    onLife: listener => { listeners.add(listener); return () => listeners.delete(listener); }, attach }, new AbortController().signal);
  await vi.waitFor(() => expect(runtime.reads.length).toBeGreaterThan(0));
  view = { ...view, kind: 'starting', version: 1 };
  runtime.restartWithoutSession();
  await vi.waitFor(() => expect(readLife).toHaveBeenCalledTimes(2));
  expect(runtime.opens).toBe(2);
  expect(runtime.reads.filter(read => read.generation === 2)).toEqual([]);
  expect(attach).toHaveBeenCalledOnce();
  runtime.restoreSession(); release();
  view = { ...view, kind: 'ready', version: 2 };
  for (const listener of [...listeners]) listener(view);
  const session = await pending;
  cleanup.push(() => session.dispose());
  expect(attach).toHaveBeenCalledTimes(2);
  expect(runtime.reads.every(read => read.available)).toBe(true);
  expect(session.canSyncDraft()).toBe(true);
});
