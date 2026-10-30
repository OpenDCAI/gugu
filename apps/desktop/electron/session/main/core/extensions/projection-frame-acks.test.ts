import { describe, expect, it, vi } from 'vitest';
import { ProjectionFrameAcks } from './projection-frame-acks';

const packet = { type: 'ack' as const, generation: 'viewer-a', frame: 1 };

describe('recovery frame acknowledgements', () => {
  it('shares an in-flight failure, then allows a genuine retry instead of caching success', async () => {
    let reject!: (reason: Error) => void;
    const gate = new Promise<void>((_resolve, no) => { reject = no; });
    const receive = vi.fn().mockReturnValueOnce(gate).mockResolvedValue(undefined);
    const acks = new ProjectionFrameAcks(() => {}, () => 'viewer-a', receive);
    const first = acks.receiveAck(packet), second = acks.receiveAck(packet);
    const failed = expect(Promise.all([first, second])).rejects.toThrow('Not drawn');
    await Promise.resolve(); expect(receive).toHaveBeenCalledTimes(1);
    reject(new Error('Not drawn')); await failed;
    await expect(second).rejects.toThrow('Not drawn');
    expect(receive).toHaveBeenCalledTimes(1);
    await acks.receiveAck(packet);
    expect(receive).toHaveBeenCalledTimes(2);
    await acks.receiveAck(packet);
    expect(receive).toHaveBeenCalledTimes(2);
  });

  it('rechecks queued authority and never treats an old generation as an acknowledged frame', async () => {
    let resolve!: () => void, current = true;
    const check = () => { if (!current) throw new Error('App revoked'); };
    const receive = vi.fn().mockReturnValueOnce(new Promise<void>(yes => { resolve = yes; })).mockResolvedValue(undefined);
    const acks = new ProjectionFrameAcks(check, () => 'viewer-a', receive);
    const first = acks.receiveAck(packet);
    const next = acks.receiveAck({ ...packet, frame: 2 });
    const failedFirst = expect(first).rejects.toThrow('App revoked');
    const failedNext = expect(next).rejects.toThrow('App revoked');
    await Promise.resolve(); current = false; resolve();
    await Promise.all([failedFirst, failedNext]);
    expect(receive).toHaveBeenCalledTimes(1);
    current = true;
    expect(() => acks.receiveAck({ ...packet, generation: 'old-viewer' })).toThrow('Stale projection frame');
    await acks.receiveAck(packet); // The revoked attempt was never cached.
    expect(receive).toHaveBeenCalledTimes(2);
  });
});
