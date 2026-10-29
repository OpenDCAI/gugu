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
});
