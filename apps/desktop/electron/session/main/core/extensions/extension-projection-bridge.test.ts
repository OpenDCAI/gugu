import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionHostEvent } from '@shared/extensions/bridge-protocol';
import { projectionSources, type ProjectionHost } from '../../../../../src/session/app-runtime/projection-source';
import type { BridgeCaller } from './extension-bridge';
import { revokeExtensionProgramAccess } from './extension-program-access';

vi.mock('./extensions-root', () => ({ extensionsService: () => ({ get() {}, isEnabled: () => true, hasCapability: () => true }) }));
vi.mock('./app-programs-elsewhere', () => ({ knownSessionMachine: (id: string) => id === 'remote-task' ? { deviceId: 'remote' } : undefined }));
const { ExtensionProjectionBridge } = await import('./extension-projection-bridge');
const owner = { extensionId: 'projection-bridge-test', kind: 'program', pageId: -400, binding: null, callingSession: 'task-a' };
const noop = () => {};
const program = (hear: BridgeCaller['hear'] = noop) => ({ ...owner, hear, filePage: noop, resourcePage: noop }) as unknown as BridgeCaller;
const page = (pageId: number, sessionId = 'task-a', hear: BridgeCaller['hear'] = noop) => ({
  ...owner, kind: 'page', pageId, callingSession: undefined, binding: { sessionId }, hear, filePage: noop, resourcePage: noop,
}) as unknown as BridgeCaller;
const frame = { width: 640, height: 480, mime: 'image/png' as const, data: 'YQ==' };
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
afterEach(() => { revokeExtensionProgramAccess(owner.extensionId); vi.useRealTimers(); });

function setup() {
  const bridge = new ExtensionProjectionBridge(() => {}, async () => 'project-test');
  let sourceEvent: Parameters<NonNullable<ProjectionHost['onProjectionSource']>>[0] = noop;
  const sourceCaller = program(event => { if (event.type === 'projectionSource') sourceEvent(event.event); });
  const call = (verb: string, args: Record<string, unknown>) => bridge.call(sourceCaller, verb, args);
  const host: ProjectionHost = {
    projection: {
      create: args => call('projectionCreate', args) as Promise<{ id: string }>,
      publish: args => call('projectionPublish', args) as Promise<void>,
      close: args => call('projectionClose', args) as Promise<void>,
      closed: args => call('projectionClosed', args) as Promise<void>,
      inputResult: args => call('projectionInputResult', args) as Promise<void>,
      watch: async () => {}, unwatch: async () => {}, send: async () => {},
    },
    onProjectionSource: callback => { sourceEvent = callback; return noop; },
  };
  return { bridge, host, sourceCaller, runtime: projectionSources(host) };
}

describe('App program → dedicated host resource → bound App page', () => {
  it('requires the exact call\'s host-stamped session, ignoring a forged session argument', async () => {
    const { bridge } = setup();
    await expect(bridge.call({ ...program(), callingSession: undefined }, 'projectionCreate', { sessionId: 'task-a' })).rejects.toThrow(/inside a task tool call/);
    await expect(bridge.call(page(1), 'projectionCreate', {})).rejects.toThrow(/inside a task tool call/);
    const { id } = await bridge.call(program(), 'projectionCreate', {}) as { id: string };
    await expect(bridge.call(page(2, 'task-b'), 'projectionWatch', { id, watchId: 'v' })).rejects.toThrow(/not in this App session/);
    bridge.closePage(owner.pageId);
    expect(bridge.count(owner.pageId)).toBe(0);
  });

  it('captures only for its viewer, sends committed text once, and acknowledges driver cleanup before close returns', async () => {
    const { bridge, runtime } = setup();
    const input = vi.fn(async () => {});
    let cleanup!: () => void;
    const closed = new Promise<void>(resolve => { cleanup = resolve; });
    const publisher = await runtime.create({ input, disconnect: async () => {}, refresh: () => { void publisher.publish(frame); }, close: () => closed });
    const events: ExtensionHostEvent[] = [];
    const viewer = page(10, 'task-a', event => events.push(event));
    const otherEvents: ExtensionHostEvent[] = [];
    page(11, 'task-b', event => otherEvents.push(event));
    await bridge.call(viewer, 'projectionWatch', { id: publisher.id, watchId: 'v' });
    await turn();
    const packet = events.find(e => e.type === 'projection' && e.packet.type === 'frame');
    expect(packet?.type).toBe('projection');
    if (packet?.type !== 'projection' || packet.packet.type !== 'frame') throw new Error('No frame');
    const generation = packet.packet.generation;
    await bridge.call(viewer, 'projectionSend', { watchId: 'v', packet: { type: 'ack', generation, frame: 1 } });
    await bridge.call(viewer, 'projectionSend', { watchId: 'v', packet: { type: 'input', generation, frame: 1, sequence: 1, input: { kind: 'text', text: '中文粘贴' } } });
    expect(input).toHaveBeenCalledExactlyOnceWith({ kind: 'text', text: '中文粘贴' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(otherEvents).toEqual([]);
    let done = false;
    const closing = publisher.close().then(() => { done = true; });
    await turn();
    expect(done).toBe(false);
    cleanup();
    await closing;
    expect(bridge.count(owner.pageId)).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: 'projection', packet: { type: 'state', state: 'closed' } });
    bridge.closePage(viewer.pageId);
  });

  it('never lets another program surface publish, close, or answer an input', async () => {
    const { bridge } = setup();
    const { id } = await bridge.call(program(), 'projectionCreate', {}) as { id: string };
    const impostor = { ...program(), pageId: -401 };
    for (const method of ['projectionPublish', 'projectionClose', 'projectionClosed', 'projectionInputResult']) {
      await expect(bridge.call(impostor, method, { id, frame: { ...frame, sequence: 1 }, requestId: 'fake' })).rejects.toThrow(/not owned/);
    }
    bridge.closePage(owner.pageId);
  });

  it('does not route a remote task picture through the generic RPC/notification relay', async () => {
    const { bridge } = setup();
    await expect(bridge.call(page(10, 'remote-task'), 'projectionWatch', { id: 'whatever', watchId: 'v' })).rejects.toThrow(/direct connection/);
  });

  it('bounds simultaneous pending watches and releases failed watch reservations', async () => {
    const { bridge, runtime } = setup();
    const publisher = await runtime.create({ input: async () => {}, disconnect: async () => {}, refresh() {}, close() {} });
    const viewer = page(80);
    const attempts = Array.from({ length: 17 }, (_, index) => bridge.call(viewer, 'projectionWatch', { id: publisher.id, watchId: String(index) }));
    const results = await Promise.allSettled(attempts);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(16);
    expect(results[16]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'Too many projection viewers' }) });
    bridge.closePage(viewer.pageId);
    const wrongTask = page(81, 'task-b');
    for (let index = 0; index < 20; index++) {
      await expect(bridge.call(wrongTask, 'projectionWatch', { id: publisher.id, watchId: String(index) })).rejects.toThrow(/not in this App session/);
    }
    wrongTask.binding!.sessionId = 'task-a';
    await expect(bridge.call(wrongTask, 'projectionWatch', { id: publisher.id, watchId: 'valid' })).resolves.toBeUndefined();
    bridge.closePage(wrongTask.pageId);
    await publisher.close();
  });

  it('keeps the native queue behind cancelled input until the App has cleaned it up', async () => {
    const { bridge, runtime } = setup();
    let release!: () => void;
    let inputSignal: AbortSignal | undefined;
    const calls: string[] = [];
    const order: string[] = [];
    const publisher = await runtime.create({
      refresh() {}, close() {}, disconnect: async () => { order.push('release-held-input'); },
      input: async (input, { signal }) => {
        calls.push(input.kind);
        order.push(`input-${calls.length}`);
        inputSignal = signal;
        if (calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
      },
    });
    const events: ExtensionHostEvent[] = [];
    const a = page(10, 'task-a', event => events.push(event));
    const b = page(11, 'task-a', event => events.push(event));
    await bridge.call(a, 'projectionWatch', { id: publisher.id, watchId: 'a' });
    await bridge.call(b, 'projectionWatch', { id: publisher.id, watchId: 'b' });
    await publisher.publish(frame);
    const generations = events.filter(e => e.type === 'projection' && e.packet.type === 'frame');
    const send = (caller: BridgeCaller, watchId: string, index: number, type: 'ack' | 'input') => {
      const event = generations[index]!;
      if (event.type !== 'projection') throw new Error('No projection');
      return bridge.call(caller, 'projectionSend', { watchId, packet: { type, generation: event.packet.generation, frame: 1, sequence: 1, input: { kind: 'text', text: 'a' } } });
    };
    await send(a, 'a', 0, 'ack');
    await send(b, 'b', 1, 'ack');
    const first = send(a, 'a', 0, 'input');
    const second = send(b, 'b', 1, 'input');
    await turn();
    bridge.closePage(a.pageId);
    await expect(first).resolves.toMatchObject({ status: 'unknown', reason: 'Input may have been applied. Check the target before trying again.' });
    expect(inputSignal!.aborted).toBe(true);
    expect(calls).toHaveLength(1);
    release();
    await second;
    expect(calls).toHaveLength(2);
    expect(order).toEqual(['input-1', 'release-held-input', 'input-2']);
    await publisher.close();
    bridge.closePage(b.pageId);
  });
  it('rejects an old task viewer after the actual page binding changes', async () => {
    const { bridge, runtime } = setup(); const input = vi.fn(async () => {});
    const source = await runtime.create({ input, disconnect: async () => {}, refresh() {}, close() {} });
    const events: ExtensionHostEvent[] = []; const viewer = page(90, 'task-a', event => events.push(event));
    await bridge.call(viewer, 'projectionWatch', { id: source.id, watchId: 'scope' });
    await source.publish(frame);
    const generation = (events[0] as Extract<ExtensionHostEvent, { type: 'projection' }>).packet.generation;
    await bridge.call(viewer, 'projectionSend', { watchId: 'scope', packet: { type: 'ack', generation, frame: 1 } });
    viewer.binding!.sessionId = 'task-b';
    await expect(bridge.call(viewer, 'projectionSend', { watchId: 'scope', packet: { type: 'input', generation, frame: 1, sequence: 1, input: { kind: 'text', text: 'must not reach task-a' } } })).rejects.toThrow(/page changed/);
    expect(input).not.toHaveBeenCalled(); await source.close();
  });

  it('releases watch reservations when a source closes, even without unwatch', async () => {
    const { bridge, runtime } = setup(); const viewer = page(91);
    for (let index = 0; index < 20; index++) {
      const source = await runtime.create({ input: async () => {}, disconnect: async () => {}, refresh() {}, close() {} });
      await bridge.call(viewer, 'projectionWatch', { id: source.id, watchId: String(index) });
      await source.close();
    }
    expect(bridge.count(owner.pageId)).toBe(0);
  });

  it('does not impose the cancellation timeout on a healthy long-running input', async () => {
    const { bridge, runtime } = setup(); let finish!: () => void;
    const closed = vi.fn();
    const source = await runtime.create({ input: async () => new Promise<void>(resolve => { finish = resolve; }), disconnect: async () => {}, refresh() {}, close: closed });
    const events: ExtensionHostEvent[] = []; const viewer = page(92, 'task-a', event => events.push(event));
    await bridge.call(viewer, 'projectionWatch', { id: source.id, watchId: 'long' }); await source.publish(frame);
    const generation = (events[0] as Extract<ExtensionHostEvent, { type: 'projection' }>).packet.generation;
    await bridge.call(viewer, 'projectionSend', { watchId: 'long', packet: { type: 'ack', generation, frame: 1 } });
    vi.useFakeTimers();
    const sending = bridge.call(viewer, 'projectionSend', { watchId: 'long', packet: { type: 'input', generation, frame: 1, sequence: 1, input: { kind: 'text', text: 'long input' } } });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await vi.advanceTimersByTimeAsync(11_000);
    expect(closed).not.toHaveBeenCalled(); finish();
    await expect(sending).resolves.toEqual({ status: 'applied' }); vi.useRealTimers(); await source.close();
  });

  it('returns a publication receipt so a driver rejects same-sized target changes instead of typing into the new target', async () => {
    const { bridge, runtime } = setup(); let target = 'tab-a'; const targets = new Map<number, string>(); const applied: string[] = [];
    const source = await runtime.create({ input: async (input, context) => {
      if (targets.get(context.frame.sequence) !== target) return { status: 'rejected', reason: 'Target changed' };
      applied.push(input.kind); return { status: 'applied' };
    }, disconnect: async () => {}, refresh() {}, close() {} });
    const events: ExtensionHostEvent[] = []; const viewer = page(93, 'task-a', event => events.push(event));
    await bridge.call(viewer, 'projectionWatch', { id: source.id, watchId: 'target' });
    targets.set(await source.publish(frame), target);
    const generation = (events[0] as Extract<ExtensionHostEvent, { type: 'projection' }>).packet.generation;
    await bridge.call(viewer, 'projectionSend', { watchId: 'target', packet: { type: 'ack', generation, frame: 1 } });
    await expect(bridge.call(viewer, 'projectionSend', { watchId: 'target', packet: { type: 'input', generation, frame: 1, sequence: 1, input: { kind: 'text', text: 'valid in tab-a' } } })).resolves.toMatchObject({ status: 'applied' });
    target = 'tab-b'; targets.set(await source.publish(frame), target);
    for (const [index, input] of [{ kind: 'text', text: 'private' }, { kind: 'key', action: 'down', key: 'Enter' }].entries()) {
      await expect(bridge.call(viewer, 'projectionSend', { watchId: 'target', packet: { type: 'input', generation, frame: 1, sequence: index + 2, input } })).resolves.toMatchObject({ status: 'rejected', reason: 'Target changed' });
    }
    expect(applied).toEqual(['text']); await source.close();
  });

});
