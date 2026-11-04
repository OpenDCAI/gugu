import { afterEach, expect, it, vi } from 'vitest';
import type { openProjectionVideo } from '../../../native/projection-media/web/viewer.mjs';
import type { ProjectionHost } from './projection-source';
const native = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../../native/projection-media/web/viewer.mjs', () => ({ openProjectionVideo: native.open }));
import { projectionVideoClient } from './projection-video-client';

const clients: Array<Awaited<ReturnType<typeof projectionVideoClient>>> = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close(); native.open.mockReset(); vi.useRealTimers(); });
async function setup() {
  const options: Array<Parameters<typeof openProjectionVideo>[0]> = [];
  const channels: Array<{ sent: string[]; closed: ReturnType<typeof Promise.withResolvers<void>>; close: ReturnType<typeof vi.fn> }> = [];
  native.open.mockImplementation(async (input: Parameters<typeof openProjectionVideo>[0]) => {
    const channel = { sent: [] as string[], closed: Promise.withResolvers<void>(), close: vi.fn() };
    channel.close.mockImplementation(() => channel.closed.resolve());
    options.push(input); channels.push(channel);
    return { closed: channel.closed.promise, sendControl: (data: string) => { channel.sent.push(data); }, close: channel.close };
  });
  let next = 0;
  const bridge = { open: vi.fn(async () => ({ id: `viewer-${++next}`, offer: { type: 'offer' as const, sdp: 'bytes' } })),
    answer: vi.fn(async () => {}), sign: vi.fn(async () => 'signed'), close: vi.fn(async () => {}) };
  const changed = vi.fn(), error = vi.fn(), frame = vi.fn();
  const client = await projectionVideoClient({ projectionMedia: bridge } as ProjectionHost, {} as HTMLVideoElement, 'source', { frame, state: changed, error });
  clients.push(client);
  const generation = (index = 0, value = 'generation-a') => options[index]!.onControl!(JSON.stringify({ type: 'projection-generation', generation: value }), () => {});
  const paint = async (index = 0) => { options[index]!.onFrame!({ sequence: 4, rtpTimestamp: 100, width: 120, height: 80 }, () => {}); await Promise.resolve(); };
  return { client, options, channels, bridge, changed, error, frame, generation, paint };
}
it('requires a fresh decoded frame and an execution receipt, not only data-channel admission', async () => {
  const test = await setup();
  await expect(test.client.input({ kind: 'text', text: '中文' })).rejects.toThrow('not ready');
  test.generation(); await test.paint();
  let settled = false;
  const work = test.client.input({ kind: 'text', text: '中文' }).then(result => { settled = true; return result; });
  await Promise.resolve(); expect(settled).toBe(false);
  const packet = JSON.parse(test.channels[0]!.sent[0]!);
  expect(packet).toMatchObject({ type: 'input', generation: 'generation-a', frame: 4, input: { kind: 'text', text: '中文' } });
  test.options[0]!.onControl!(JSON.stringify({ type: 'input-result', generation: 'generation-a', sequence: packet.sequence, status: 'applied' }), () => {});
  await expect(work).resolves.toEqual({ status: 'applied' });
});
it('a late frame ACK cannot re-enable input after that decoded frame was invalidated', async () => {
  const test = await setup(); test.generation();
  const ack = Promise.withResolvers<void>();
  test.options[0]!.onFrame!({ sequence: 4, rtpTimestamp: 100, width: 120, height: 80 }, () => ack.promise);
  test.options[0]!.onFrame!(null, () => {}); ack.resolve(); await Promise.resolve();
  expect(test.frame).toHaveBeenLastCalledWith(null);
  await expect(test.client.input({ kind: 'text', text: 'still blocked' })).rejects.toThrow('not ready');
});
it('disconnection leaves in-flight input uncertain and does not replay it on a new generation', async () => {
  const test = await setup(); test.generation(); await test.paint();
  const work = test.client.input({ kind: 'text', text: 'do not repeat' });
  await Promise.resolve(); test.channels[0]!.closed.reject(new Error('disconnected'));
  await expect(work).resolves.toMatchObject({ status: 'unknown' });
  await test.client.reset(); test.generation(1, 'generation-b'); await test.paint(1);
  expect(test.channels[1]!.sent).toEqual([]);
  expect(test.bridge.close).toHaveBeenCalledWith({ id: 'viewer-1' });
});
it('old stream callbacks cannot overwrite or enable a replacement viewer', async () => {
  const test = await setup(); test.generation(); await test.paint();
  await test.client.reset();
  test.generation(0, 'stale-generation'); await test.paint(0);
  await expect(test.client.input({ kind: 'text', text: 'blocked' })).rejects.toThrow('not ready');
  test.generation(1, 'new-generation'); await test.paint(1);
  const work = test.client.input({ kind: 'text', text: 'new' }); await Promise.resolve();
  const packet = JSON.parse(test.channels[1]!.sent[0]!);
  expect(packet.generation).toBe('new-generation');
  await test.client.close(); await expect(work).resolves.toMatchObject({ status: 'unknown' });
});
