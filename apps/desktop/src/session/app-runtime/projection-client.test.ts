import { describe, expect, it, vi } from 'vitest';
import type { ProjectionHost } from './projection-source';
import type { ProjectionHostPacket } from '@shared/extensions/projection-protocol';
import { projectionClient } from './projection-client';

function host() {
  let hear: (watch: string, packet: ProjectionHostPacket) => void = () => {};
  let watchId = '';
  const projection = {
    create: vi.fn(), publish: vi.fn(), close: vi.fn(), closed: vi.fn(), inputResult: vi.fn(),
    watch: vi.fn(async (args: { watchId: string }) => { watchId = args.watchId; }),
    unwatch: vi.fn(async () => {}), send: vi.fn(async () => {}),
  } as unknown as NonNullable<ProjectionHost['projection']>;
  return { projection, onProjection: (fn: typeof hear) => { hear = fn; return vi.fn(); }, emit: (packet: ProjectionHostPacket) => hear(watchId, packet) };
}
const frame = { sequence: 1, width: 1, height: 1, mime: 'image/png' as const, data: 'YQ==' };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('painted frame and reconnect input routing', () => {
  it('bounds a flood of release barriers by resetting the old generation instead of discarding releases', async () => {
    const h = host(); const blocked = Promise.withResolvers<void>();
    vi.mocked(h.projection.send).mockImplementation(async ({ packet }) => {
      if (packet.type === 'input' && packet.sequence === 1) await blocked.promise;
    });
    const client = await projectionClient(h, 'source', { paint: async () => {} });
    h.emit({ type: 'state', generation: 'a', state: 'connecting' });
    h.emit({ type: 'frame', generation: 'a', frame }); await flush();
    const down = client.input({ kind: 'key', action: 'down', key: 'Shift' });
    const release = Array.from({ length: 65 }, (_, key) => client.input({ kind: 'key', action: 'up', key: `key-${key}` }));
    await Promise.all(release);
    expect(h.projection.watch).toHaveBeenCalledTimes(2);
    blocked.resolve(); await down;
    h.emit({ type: 'state', generation: 'b', state: 'connecting' });
    h.emit({ type: 'frame', generation: 'b', frame }); await flush();
    await expect(client.input({ kind: 'text', text: 'new generation' })).resolves.toEqual({ status: 'applied' });
    const input = vi.mocked(h.projection.send).mock.calls.map(([args]) => args.packet).filter(packet => packet.type === 'input');
    expect(input.map(packet => packet.generation)).toEqual(['a', 'b']);
    await client.close();
  });

  it.each(['key', 'pointer'] as const)('keeps a %s release barrier when ordinary queued input is full', async kind => {
    const h = host(); const blocked = Promise.withResolvers<void>();
    vi.mocked(h.projection.send).mockImplementation(async ({ packet }) => {
      if (packet.type === 'input' && packet.sequence === 1) await blocked.promise;
    });
    const client = await projectionClient(h, 'source', { paint: async () => {} });
    h.emit({ type: 'state', generation: 'a', state: 'connecting' });
    h.emit({ type: 'frame', generation: 'a', frame }); await flush();
    const control = kind === 'key' ? { kind: 'key' as const, key: 'Shift' } : { kind: 'pointer' as const, button: 'left' as const, x: 0.5, y: 0.5 };
    const down = client.input({ ...control, action: 'down' });
    const queued = Array.from({ length: 64 }, () => client.input({ kind: 'text', text: 'not yet dispatched' }));
    const up = client.input({ ...control, action: 'up' });
    blocked.resolve();
    const released = await up;
    await Promise.all([down, ...queued]);
    expect(released).toEqual({ status: 'applied' });
    const inputs = vi.mocked(h.projection.send).mock.calls.map(([args]) => args.packet).filter(packet => packet.type === 'input');
    expect(inputs.map(packet => packet.input)).toEqual([{ ...control, action: 'down' }, { ...control, action: 'up' }]);
    await client.close();
  });

  it('ACKs only after paint and accepts one committed text event after that ACK', async () => {
    const h = host();
    let painted!: () => void;
    const paint = new Promise<void>(resolve => { painted = resolve; });
    const client = await projectionClient(h, 'source', { paint: () => paint });
    h.emit({ type: 'state', generation: 'a', state: 'connecting' });
    h.emit({ type: 'frame', generation: 'a', frame });
    await expect(client.input({ kind: 'text', text: 'before' })).rejects.toThrow(/not ready/);
    expect(h.projection.send).not.toHaveBeenCalled();
    painted();
    await flush();
    await client.input({ kind: 'text', text: '中文粘贴' });
    expect(h.projection.send).toHaveBeenCalledTimes(2);
    expect(h.projection.send).toHaveBeenLastCalledWith({ watchId: expect.any(String), packet: { type: 'input', generation: 'a', frame: 1, sequence: 1, input: { kind: 'text', text: '中文粘贴' } } });
    await client.close();
  });

  it('a disconnected or previous-generation image finishing paint cannot re-enable input', async () => {
    const h = host();
    let painted!: () => void;
    const painting = new Promise<void>(resolve => { painted = resolve; });
    const client = await projectionClient(h, 'source', { paint: () => painting });
    h.emit({ type: 'state', generation: 'old', state: 'connecting' });
    h.emit({ type: 'frame', generation: 'old', frame });
    h.emit({ type: 'state', generation: 'old', state: 'closed' });
    painted();
    await flush();
    expect(h.projection.send).not.toHaveBeenCalled();
    await expect(client.input({ kind: 'text', text: 'late' })).rejects.toThrow(/not ready/);
    h.emit({ type: 'state', generation: 'new', state: 'connecting' });
    h.emit({ type: 'frame', generation: 'old', frame: { ...frame, sequence: 2 } });
    await flush();
    expect(h.projection.send).not.toHaveBeenCalled();
    h.emit({ type: 'frame', generation: 'new', frame: { ...frame, sequence: 3 } });
    await flush();
    await client.input({ kind: 'text', text: 'new' });
    expect(h.projection.send).toHaveBeenLastCalledWith(expect.objectContaining({ packet: expect.objectContaining({ generation: 'new', frame: 3, sequence: 1 }) }));
    await client.close();
  });
  it('coalesces continuous input behind a busy driver while keeping discrete barriers and the original generation', async () => {
    const h = host();
    let finish!: () => void;
    vi.mocked(h.projection.send).mockImplementation(async ({ packet }) => {
      if (packet.type === 'input' && packet.sequence === 1) await new Promise<void>(resolve => { finish = resolve; });
    });
    const client = await projectionClient(h, 'source', { paint: async () => {} });
    h.emit({ type: 'state', generation: 'a', state: 'connecting' });
    h.emit({ type: 'frame', generation: 'a', frame });
    await flush();
    const first = client.input({ kind: 'key', action: 'down', key: 'Shift' });
    const moves = Array.from({ length: 100 }, (_, index) => client.input({ kind: 'pointer', action: 'move', button: 'left', x: index / 100, y: 0.5 }));
    const up = client.input({ kind: 'key', action: 'up', key: 'Shift' });
    const wheels = Array.from({ length: 100 }, () => client.input({ kind: 'wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: 1 }));
    expect(h.projection.send).toHaveBeenCalledTimes(2); // painted ACK + the one executing input
    finish();
    await Promise.all([first, ...moves, up, ...wheels]);
    const inputs = vi.mocked(h.projection.send).mock.calls.map(([args]) => args.packet).filter(p => p.type === 'input');
    expect(inputs.map(p => p.input)).toEqual([
      { kind: 'key', action: 'down', key: 'Shift' },
      { kind: 'pointer', action: 'move', button: 'left', x: 0.99, y: 0.5 },
      { kind: 'key', action: 'up', key: 'Shift' },
      { kind: 'wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: 100 },
    ]);
    expect(inputs.every(p => p.generation === 'a' && p.frame === 1)).toBe(true);
    await client.close();
  });

});
