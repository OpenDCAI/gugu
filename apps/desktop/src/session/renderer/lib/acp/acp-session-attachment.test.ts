import { beforeEach, expect, it, vi } from 'vitest';
import type { LifeView } from '@shared/core/sessions/session-life';
import { attachAcpSessionWhenReady } from './acp-session-attachment';

const host = vi.hoisted(() => {
  const state = {
    connected: true, generation: 0, view: null as unknown as LifeView,
    changes: new Set<(view: LifeView) => void>(),
    disconnects: new Set<() => void>(), reconnects: new Set<() => void>(),
    read: vi.fn<() => Promise<LifeView>>(),
    create: vi.fn<() => Promise<{ dispose(): void }>>(),
  };
  const connection = {
    get connected() { return state.connected; },
    get generation() { return state.generation; },
    onDisconnect: (listener: () => void) => { state.disconnects.add(listener); return () => state.disconnects.delete(listener); },
    whenConnected: (signal: AbortSignal) => {
      if (signal.aborted) return Promise.reject(signal.reason);
      if (state.connected) return Promise.resolve(state.generation);
      return new Promise<number>((resolve, reject) => {
        const cleanup = () => { state.reconnects.delete(done); signal.removeEventListener('abort', abort); };
        const done = () => { cleanup(); resolve(state.generation); };
        const abort = () => { cleanup(); reject(signal.reason); };
        state.reconnects.add(done); signal.addEventListener('abort', abort, { once: true });
      });
    },
  };
  return { ...state, connection, state };
});
vi.mock('../machine-routing', () => ({ machineRegistry: { machineOf: () => 'ssh-test' } }));
vi.mock('./runtime-client', () => ({ getAcpRuntimeClient: async () => ({ connection: host.connection }) }));
vi.mock('./acp-live-session', () => ({ AcpLiveSession: { create: () => host.create() } }));
vi.mock('../ipc', () => ({
  rpcOn: () => ({ sessions: { lifeView: () => host.read() } }),
  onMachineEvent: (_machine: string, _event: unknown, listener: (view: LifeView) => void) => {
    host.changes.add(listener); return () => host.changes.delete(listener);
  },
}));

function life(kind: LifeView['kind'], version = 1): LifeView {
  return { sessionId: 'session', version, kind, stage: null, pending: { count: 0, items: [] },
    hold: null, failure: null, lastExit: null, nativeSession: null };
}
function emit(view: LifeView) {
  host.state.view = view;
  for (const listener of [...host.changes]) listener(view);
}
function disconnect() {
  host.state.connected = false;
  for (const listener of [...host.disconnects]) listener();
}
function reconnect(view: LifeView) {
  host.state.view = view; host.state.generation++; host.state.connected = true;
  for (const listener of [...host.reconnects]) listener();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  host.state.connected = true; host.state.generation = 0; host.state.view = life('ready');
  host.changes.clear(); host.disconnects.clear(); host.reconnects.clear();
  host.read.mockReset().mockImplementation(async () => host.state.view);
  host.create.mockReset().mockImplementation(async () => ({ dispose: vi.fn() }));
});

it('does not attach when the connection returns before the host is ready', async () => {
  host.state.connected = false;
  const controller = new AbortController();
  const pending = attachAcpSessionWhenReady('session', controller.signal);
  await vi.waitFor(() => expect(host.reconnects.size).toBe(1));
  expect(host.read).not.toHaveBeenCalled();
  reconnect(life('starting'));
  await vi.waitFor(() => expect(host.read).toHaveBeenCalledOnce());
  expect(host.create).not.toHaveBeenCalled();
  emit({ ...life('ready', 2), sessionId: 'another-session' });
  expect(host.create).not.toHaveBeenCalled();
  emit(life('ready', 2));
  await pending;
  expect(host.create).toHaveBeenCalledOnce();
  expect(host.changes.size).toBe(0);
});

it('abandons a first attachment in flight and creates its replacement only after current ready', async () => {
  const first = deferred<{ dispose(): void }>();
  const old = { dispose: vi.fn() }, current = { dispose: vi.fn() };
  host.create.mockReturnValueOnce(first.promise).mockResolvedValueOnce(current);
  const pending = attachAcpSessionWhenReady('session', new AbortController().signal);
  await vi.waitFor(() => expect(host.create).toHaveBeenCalledOnce());
  disconnect(); reconnect(life('starting'));
  await vi.waitFor(() => expect(host.read).toHaveBeenCalledTimes(2));
  first.resolve(old);
  await vi.waitFor(() => expect(old.dispose).toHaveBeenCalledOnce());
  expect(host.create).toHaveBeenCalledOnce();
  emit(life('ready', 2));
  expect(await pending).toBe(current);
  expect(host.create).toHaveBeenCalledTimes(2);
});

it('discards an old connection read even when it reports a larger ready version', async () => {
  const old = deferred<LifeView>();
  host.read.mockReturnValueOnce(old.promise);
  const pending = attachAcpSessionWhenReady('session', new AbortController().signal);
  await vi.waitFor(() => expect(host.read).toHaveBeenCalledOnce());
  disconnect(); reconnect(life('starting', 1));
  await vi.waitFor(() => expect(host.read).toHaveBeenCalledTimes(2));
  old.resolve(life('ready', 99));
  await Promise.resolve(); await Promise.resolve();
  expect(host.create).not.toHaveBeenCalled();
  emit(life('ready', 2));
  await pending;
  expect(host.create).toHaveBeenCalledOnce();
});

it('keeps a genuine current-connection attachment failure visible without retrying it', async () => {
  const error = Object.assign(new Error('Missing live session'), { code: 'NOT_FOUND' });
  host.create.mockRejectedValue(error);
  await expect(attachAcpSessionWhenReady('session', new AbortController().signal)).rejects.toBe(error);
  emit(life('ready', 2));
  expect(host.create).toHaveBeenCalledOnce();
  expect(host.changes.size).toBe(0);
  expect(host.disconnects.size).toBe(0);
});

it('cancels a disposed page while waiting and releases its event subscription', async () => {
  host.state.view = life('starting');
  const controller = new AbortController();
  const pending = attachAcpSessionWhenReady('session', controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(host.changes.size).toBe(1));
  controller.abort(); await rejected;
  expect(host.changes.size).toBe(0);
  expect(host.disconnects.size).toBe(0);
  expect(host.create).not.toHaveBeenCalled();
});

it('reports the host startup failure instead of attaching or inventing a recovery', async () => {
  host.state.view = { ...life('failed'), failure: { at: 'process', message: 'Engine executable is unavailable',
    cause: { name: 'Error', message: 'Engine executable is unavailable' } } };
  await expect(attachAcpSessionWhenReady('session', new AbortController().signal)).rejects.toThrow('Engine executable is unavailable');
  expect(host.create).not.toHaveBeenCalled();
});


it('cancels a page queued for a disconnected port without retaining a reconnect waiter', async () => {
  host.state.connected = false;
  const controller = new AbortController();
  const pending = attachAcpSessionWhenReady('session', controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(host.reconnects.size).toBe(1));
  controller.abort(); await rejected;
  expect(host.reconnects.size).toBe(0);
  expect(host.read).not.toHaveBeenCalled();
  expect(host.create).not.toHaveBeenCalled();
});
