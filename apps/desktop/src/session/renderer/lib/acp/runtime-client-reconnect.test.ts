import { afterEach, expect, it, vi } from 'vitest';
import { memoryTransportPair, reconnectingTransport, serve, type LiveSnapshot, type WireTransport } from '@gugu/session-wire';
import { getAcpRuntimeClient, resetAcpRuntimeClient } from './runtime-client';

const runtime = vi.hoisted(() => ({ transport: null as unknown as WireTransport }));
vi.mock('../machine-clients', () => ({ machineWireTransport: () => runtime.transport }));
vi.mock('../electron-api', () => ({ electronApi: () => { throw new Error('Remote state reads do not use a local port'); } }));

const pending = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); resetAcpRuntimeClient(); });

it.each(['snapshot', 'attach'] as const)('automatically recovers a state %s disconnected before its first result', async operation => {
  const first = memoryTransportPair(), second = memoryTransportPair();
  const started = pending<void>(), resume = pending<WireTransport>(), held = pending<void>();
  const snapshot: LiveSnapshot<unknown> = { generation: 2, sequence: 0, timestamp: 0, data: { lifecycle: 'ready' } };
  let opens = 0;
  runtime.transport = reconnectingTransport(async () => opens++ === 0 ? first.left : resume.promise);
  const stopFirst = serve(first.right, { call: vi.fn(), resolveLive: () => ({
    snapshot: async () => { started.resolve(); await held.promise; return snapshot; },
    subscribe: async () => { started.resolve(); await held.promise; return () => {}; },
  }) });
  const unsubscribe = vi.fn();
  const stopSecond = serve(second.right, { call: vi.fn(), resolveLive: () => ({ snapshot: () => snapshot, subscribe: () => unsubscribe }) });
  cleanup.push(() => { held.resolve(); runtime.transport.close?.(); stopFirst(); stopSecond(); second.disconnect(); });
  const client = await getAcpRuntimeClient('test-device');
  const handle = client.session.state({ sessionId: 'test-session' }, 'state');
  let failure: unknown = null;
  const reading = (operation === 'snapshot' ? handle.snapshot() : handle.attach(() => {})).catch(error => { failure = error; return null; });
  await started.promise;
  first.disconnect();
  resume.resolve(second.left);
  const result = await reading;
  expect(failure, 'an interrupted live-state read must reconnect without a user retry').toBeNull();
  expect(opens).toBe(2);
  if (operation === 'snapshot') expect(result).toMatchObject(snapshot);
  else { expect(result).toBeTypeOf('function'); (result as () => void)(); }
});
