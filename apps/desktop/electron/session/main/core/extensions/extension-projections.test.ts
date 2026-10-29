import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectionHostPacket } from '@shared/extensions/projection-protocol';
import { ExtensionProjections, type ProjectionSource } from './extension-projections';
import { revokeExtensionProgramAccess } from './extension-program-access';

const owner = { extensionId: 'computer-test', sessionId: 'task-a' };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
};
function wire(transport: 'local' = 'local') {
  const packets: ProjectionHostPacket[] = [];
  let lost = () => {};
  return {
    packets,
    transport,
    send: (packet: ProjectionHostPacket) => { packets.push(packet); },
    onClose: (close: () => void) => { lost = close; return () => { lost = () => {}; }; },
    disconnect: () => lost(),
    generation: () => packets[0]!.generation,
    frames: () => packets.filter(p => p.type === 'frame').map(p => p.frame.sequence),
  };
}
function setup(overrides: Partial<ProjectionSource> = {}) {
  const authorize = vi.fn();
  const resources = new ExtensionProjections(authorize);
  const source: ProjectionSource = { input: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), refresh: vi.fn(), close: vi.fn(), ...overrides };
  const resource = resources.open(owner, source);
  const publish = (sequence: number) => resource.publish({ sequence, width: 640, height: 480, mime: 'image/png', data: 'aGVsbG8=' });
  const attach = (transport: 'local' = 'local') => {
    const connection = wire(transport);
    const viewer = resources.connect(owner, resource.id, connection);
    const ack = (frame: number) => viewer.receive({ type: 'ack', generation: connection.generation(), frame });
    const input = (sequence: number, frame = 1) => viewer.receive({ type: 'input', generation: connection.generation(), frame, sequence, input: { kind: 'text', text: '中文粘贴' } });
    return { connection, viewer, ack, input };
  };
  return { resources, resource, source, authorize, publish, attach };
}
afterEach(() => {
  revokeExtensionProgramAccess(owner.extensionId);
  revokeExtensionProgramAccess('other-app');
});

describe('App/session scoped picture and input', () => {
  it('rejects another App or task, even when it knows the resource id', async () => {
    const s = setup();
    for (const principal of [{ ...owner, sessionId: 'task-b' }, { ...owner, extensionId: 'other-app' }]) {
      expect(() => s.resources.connect(principal, s.resource.id, wire())).toThrow(/not in this App session/);
    }
    expect(s.source.refresh).not.toHaveBeenCalled();
    await s.resource.close();
  });

  it('requires the installed/granted App when input is admitted', async () => {
    const s = setup();
    const v = s.attach();
    s.publish(1);
    await v.ack(1);
    s.authorize.mockImplementation(() => { throw new Error('denied'); });
    await expect(v.input(1)).rejects.toThrow('denied');
    expect(s.source.input).not.toHaveBeenCalled();
    expect(() => s.resource.publish({})).toThrow('denied');
    expect(() => s.resources.open(owner, s.source)).toThrow('denied');
    await s.resource.close();
  });

  it('keeps one outstanding frame and replaces intermediate pending frames', async () => {
    const s = setup();
    const v = s.attach();
    for (let i = 1; i <= 100; i++) s.publish(i);
    expect(v.connection.frames()).toEqual([1]);
    await v.ack(1);
    expect(v.connection.frames()).toEqual([1, 100]);
    // While the new image decodes, input still belongs to the last image actually painted.
    await v.input(1);
    await v.ack(100);
    await expect(v.input(2, 1)).rejects.toThrow(/Stale/);
    await v.input(2, 100);
    expect(s.source.input).toHaveBeenCalledTimes(2);
    expect(s.source.input).toHaveBeenLastCalledWith({ kind: 'text', text: '中文粘贴' }, expect.objectContaining({ frame: expect.objectContaining({ sequence: 100 }) }));
    await s.resource.close();
  });

  it('rejects input before painted ACK, duplicate sequence, stale ACK, and an invented generation', async () => {
    const s = setup();
    const v = s.attach();
    s.publish(1);
    await expect(v.input(1)).rejects.toThrow(/Stale/);
    await expect(v.ack(2)).rejects.toThrow(/Stale/);
    await v.ack(1);
    await expect(v.viewer.receive({ type: 'ack', generation: 'invented', frame: 1 })).rejects.toThrow(/Stale/);
    await v.input(1);
    await expect(v.input(1)).rejects.toThrow(/Stale/);
    expect(s.source.input).toHaveBeenCalledTimes(1);
    await s.resource.close();
  });

  it('reconnects with a fresh generation and a newly captured frame, without replaying old input', async () => {
    const s = setup();
    const a = s.attach();
    s.publish(1);
    await a.ack(1);
    a.connection.disconnect();
    const b = s.attach();
    expect(b.connection.generation()).not.toBe(a.connection.generation());
    expect(b.connection.frames()).toEqual([]);
    await expect(b.input(1)).rejects.toThrow(/Stale/);
    await expect(b.viewer.receive({ type: 'input', generation: a.connection.generation(), frame: 1, sequence: 1, input: { kind: 'text', text: 'old' } })).rejects.toThrow(/Stale/);
    s.publish(2);
    await b.ack(2);
    await b.input(1, 2);
    expect(s.source.refresh).toHaveBeenCalledTimes(2);
    expect(s.source.input).toHaveBeenCalledTimes(1);
    await s.resource.close();
  });

  it('does not send local preview pictures over an unnegotiated direct or relay connection', () => {
    const s = setup();
    for (const transport of ['direct', 'relay']) {
      expect(() => s.resources.connect(owner, s.resource.id, { ...wire(), transport: transport as 'local' })).toThrow(/local only/);
    }
    expect(s.source.refresh).not.toHaveBeenCalled();
  });

  it('disconnects one viewer without closing the source or the other viewer of the same task', async () => {
    const s = setup();
    const a = s.attach();
    const b = s.attach();
    s.publish(1);
    await a.ack(1);
    await b.ack(1);
    a.connection.disconnect();
    await expect(a.input(1)).rejects.toThrow(/closed/i);
    await b.input(1);
    expect(s.source.close).not.toHaveBeenCalled();
    await s.resource.close();
  });

  it('App revoke synchronously stops its source/input and leaves a different App usable', async () => {
    const stopped = deferred();
    let inputSignal: AbortSignal | undefined;
    const s = setup({ input: vi.fn(async (_input, { signal }) => { inputSignal = signal; await stopped.promise; }) });
    const other = s.resources.open({ ...owner, extensionId: 'other-app' }, { ...s.source, close: vi.fn() });
    const v = s.attach();
    s.publish(1);
    await v.ack(1);
    const input = v.input(1);
    await vi.waitFor(() => expect(inputSignal).toBeDefined(), { timeout: 1000 });
    revokeExtensionProgramAccess(owner.extensionId);
    expect(inputSignal!.aborted).toBe(true);
    expect(s.source.close).not.toHaveBeenCalled();
    expect(v.connection.packets.at(-1)).toMatchObject({ type: 'state', state: 'closed' });
    await expect(input).rejects.toThrow(/closed/);
    expect(() => other.publish({ sequence: 1, width: 1, height: 1, mime: 'image/png', data: 'YQ==' })).not.toThrow();
    stopped.resolve();
    await s.resource.close();
    expect(s.source.close).toHaveBeenCalledTimes(1);
    await other.close();
  });

  it('preserves source input order and drops a disconnected viewer\'s queued event', async () => {
    const blocked = deferred();
    const calls: string[] = [];
    const s = setup({ input: vi.fn(async (input) => { calls.push(input.kind); if (calls.length === 1) await blocked.promise; }) });
    const a = s.attach();
    const b = s.attach();
    s.publish(1);
    await a.ack(1);
    await b.ack(1);
    const first = a.input(1);
    const discarded = a.input(2);
    const next = b.input(1);
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 1000 });
    a.viewer.close();
    await expect(first).rejects.toThrow(/closed/i);
    await expect(discarded).rejects.toThrow(/closed/i);
    expect(calls).toHaveLength(1);
    blocked.resolve();
    await next;
    expect(calls).toHaveLength(2);
    await s.resource.close();
  });

  it('bounds queued native input and awaits cleanup on repeated close', async () => {
    const blocked = deferred();
    const cleanup = deferred();
    const s = setup({ input: () => blocked.promise, close: () => cleanup.promise });
    const v = s.attach();
    s.publish(1);
    await v.ack(1);
    const inputs = Array.from({ length: 64 }, (_, i) => v.input(i + 1).catch(() => undefined));
    await expect(v.input(65)).rejects.toThrow(/queue is full/);
    let closed = false;
    const close = s.resource.close().then(() => { closed = true; });
    const again = s.resource.close();
    await Promise.resolve();
    expect(closed).toBe(false);
    blocked.resolve();
    cleanup.resolve();
    await Promise.all([close, again, ...inputs]);
    expect(closed).toBe(true);
  });

  it('rejects a queued pointer if the source resized after the displayed frame', async () => {
    const blocked = deferred();
    const s = setup({ input: vi.fn(async () => { await blocked.promise; }) });
    const v = s.attach();
    s.publish(1);
    await v.ack(1);
    const first = v.input(1);
    await vi.waitFor(() => expect(s.source.input).toHaveBeenCalledTimes(1), { timeout: 1000 });
    const pointer = v.viewer.receive({ type: 'input', generation: v.connection.generation(), frame: 1, sequence: 2,
      input: { kind: 'pointer', action: 'down', button: 'left', x: 0.5, y: 0.5 },
    });
    s.resource.publish({ sequence: 2, width: 320, height: 240, mime: 'image/png', data: 'YQ==' });
    blocked.resolve();
    await first;
    await expect(pointer).rejects.toThrow(/geometry changed/);
    expect(s.source.input).toHaveBeenCalledTimes(1);
    await s.resource.close();
  });

  it('handles a synchronously dead transport without recursion or leaked viewer', async () => {
    const s = setup();
    const connection = wire();
    connection.send = () => { throw new Error('lost'); };
    const viewer = s.resources.connect(owner, s.resource.id, connection);
    await expect(viewer.receive({ type: 'ack', generation: 'old', frame: 1 })).rejects.toThrow(/closed/i);
    await s.resource.close();
  });
  it('rechecks grants at execution after the operation was admitted into the queue', async () => {
    const blocked = deferred();
    const s = setup({ input: vi.fn(async () => blocked.promise) });
    const v = s.attach(); s.publish(1); await v.ack(1);
    const first = v.input(1);
    await vi.waitFor(() => expect(s.source.input).toHaveBeenCalledTimes(1));
    const queued = v.input(2);
    s.authorize.mockImplementation(() => { throw new Error('withdrawn after admission'); });
    blocked.resolve(); await first;
    await expect(queued).rejects.toThrow('withdrawn after admission');
    expect(s.source.input).toHaveBeenCalledTimes(1);
    await s.resource.close();
  });

  it('allows one controller and releases held keys/buttons before handing control to another viewer', async () => {
    const held = new Set<string>(); const order: string[] = [];
    const s = setup({ input: async (input) => { if (input.kind === 'key') held.add(input.key); else held.add('mouse'); },
      disconnect: async () => { held.clear(); order.push('released'); }, close: () => { expect(held.size).toBe(0); order.push('closed'); } });
    const a = s.attach(); const b = s.attach(); s.publish(1); await a.ack(1); await b.ack(1);
    await a.viewer.receive({ type: 'input', generation: a.connection.generation(), frame: 1, sequence: 1, input: { kind: 'key', action: 'down', key: 'Shift' } });
    await a.viewer.receive({ type: 'input', generation: a.connection.generation(), frame: 1, sequence: 2, input: { kind: 'pointer', action: 'down', button: 'left', x: 0.5, y: 0.5 } });
    expect(held.size).toBe(2);
    await expect(b.input(1)).rejects.toThrow(/another viewer/);
    a.viewer.close(); await b.input(2);
    expect(order).toEqual(['released']);
    expect(held).toEqual(new Set(['mouse']));
    revokeExtensionProgramAccess(owner.extensionId);
    await s.resource.close();
    expect(held.size).toBe(0);
    expect(order).toEqual(['released', 'released', 'closed']);
  });

  it('ends only the named task/project and bounds resources with no viewer', async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const otherClose = vi.fn();
      const other = s.resources.open({ ...owner, sessionId: 'task-b', projectId: 'project-b' }, { ...s.source, close: otherClose });
      s.resources.closeScope({ sessionId: owner.sessionId });
      await s.resource.close();
      expect(otherClose).not.toHaveBeenCalled();
      s.resources.closeScope({ projectId: 'project-b' }); await other.close();
      expect(otherClose).toHaveBeenCalledOnce();
      const idle = setup();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(idle.source.close).toHaveBeenCalledOnce();
      await idle.resource.close();
    } finally { vi.useRealTimers(); }
  });

});
