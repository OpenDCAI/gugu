import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostWsServerMessage } from '@shared/lib/ipc/host-ws-protocol';
import {
  createRemotePtyPacer,
  REMOTE_PTY_BURST,
  REMOTE_PTY_BYTES_PER_SEC,
  REMOTE_PTY_FLUSH_MS,
} from './remote-pty-pacer';

describe('remote pty pacer (@@@remote-pty-pacer)', () => {
  let t = 0;
  let sent: HostWsServerMessage[];
  const send = (message: HostWsServerMessage) => { sent.push(message); };
  const pty = (data: string, id = 'p1'): HostWsServerMessage => ({ t: 'event', channel: `pty:data.${id}`, data });
  const screenSnapshot = vi.fn(async (_id: string) => ({ data: 'SCREEN', live: 'LIVE', size: { cols: 80, rows: 24 } }));

  beforeEach(() => {
    vi.useFakeTimers();
    t = 0;
    sent = [];
    screenSnapshot.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  const advance = async (ms: number) => {
    t += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };

  it('coalesces a terminal\'s output into one frame per flush interval', async () => {
    const pacer = createRemotePtyPacer({ screenSnapshot, now: () => t });
    pacer.outgoing(pty('a'), send);
    pacer.outgoing(pty('b'), send);
    expect(sent).toEqual([]);
    await advance(REMOTE_PTY_FLUSH_MS);
    expect(sent).toEqual([pty('ab')]);
  });

  it('other frames pass straight through, after the terminal output queued before them', async () => {
    const pacer = createRemotePtyPacer({ screenSnapshot, now: () => t });
    pacer.outgoing(pty('last lines'), send);
    pacer.outgoing({ t: 'event', channel: 'pty:exit.p1', data: { exitCode: 0 } }, send);
    expect(sent).toEqual([pty('last lines'), { t: 'event', channel: 'pty:exit.p1', data: { exitCode: 0 } }]);
  });

  it('falling behind drops the backlog and sends a reset plus the current screen; output during the snapshot is in it', async () => {
    let release!: () => void;
    const slowSnapshot = vi.fn((_id: string) => new Promise<{ data: string; live: string; size: { cols: number; rows: number } }>((resolve) => {
      release = () => resolve({ data: 'SCREEN', live: 'LIVE', size: { cols: 80, rows: 24 } });
    }));
    const pacer = createRemotePtyPacer({ screenSnapshot: slowSnapshot, now: () => t });
    pacer.outgoing(pty('x'.repeat(REMOTE_PTY_BURST + 1)), send);
    await advance(REMOTE_PTY_FLUSH_MS);
    await advance(1);
    expect(slowSnapshot).toHaveBeenCalledWith('p1');
    // 等快照时到的输出不再攒:它在快照的 live 里。
    pacer.outgoing(pty('during'), send);
    await advance(REMOTE_PTY_FLUSH_MS);
    expect(sent).toEqual([]);
    release();
    await advance(0);
    expect(sent).toEqual([pty('\x1bcSCREENLIVE')]);
    // 之后照常合帧(桶此刻是负的,等它回到够发这一小段)。
    pacer.outgoing(pty('next'), send);
    await advance(REMOTE_PTY_FLUSH_MS);
    await advance(2_000);
    expect(sent.some((m) => (m as { data: string }).data === 'next')).toBe(true);
  });

  it('holds the average to REMOTE_PTY_BYTES_PER_SEC under a steady flood', async () => {
    const pacer = createRemotePtyPacer({ screenSnapshot, now: () => t });
    const chunk = 'y'.repeat(4 * 1024);
    for (let i = 0; i < 600; i += 1) {
      pacer.outgoing(pty(chunk), send);
      await advance(REMOTE_PTY_FLUSH_MS);
    }
    const bytes = sent.reduce((sum, m) => sum + String((m as { data: string }).data).length, 0);
    const seconds = (600 * REMOTE_PTY_FLUSH_MS) / 1000;
    expect(bytes).toBeLessThanOrEqual(REMOTE_PTY_BURST + seconds * REMOTE_PTY_BYTES_PER_SEC + 64);
    // 洪水是 40 KB/s;发出去的不到它的 1/4。
    expect(bytes).toBeLessThan((600 * chunk.length) / 4);
  });

  it('counts UTF-8 bytes instead of JavaScript characters', async () => {
    const pacer = createRemotePtyPacer({ screenSnapshot, now: () => t });
    pacer.outgoing(pty('字'.repeat(REMOTE_PTY_BURST / 2)), send);
    await advance(REMOTE_PTY_FLUSH_MS + 1);
    expect(sent.every((m) => Buffer.byteLength(String((m as { data: string }).data), 'utf8') < REMOTE_PTY_BURST)).toBe(true);
    expect(screenSnapshot).toHaveBeenCalled();
  });

  it('cancels delayed output when the viewer unsubscribes', async () => {
    let release!: (snapshot: { data: string; live: string; size: { cols: number; rows: number } }) => void;
    const pacer = createRemotePtyPacer({
      screenSnapshot: () => new Promise((resolve) => { release = resolve; }),
      now: () => t,
    });
    pacer.outgoing(pty('x'.repeat(REMOTE_PTY_BURST + 1)), send);
    await advance(REMOTE_PTY_FLUSH_MS);
    await advance(1);
    pacer.unsubscribe('pty:data.p1');
    release({ data: 'hidden screen', live: '', size: { cols: 80, rows: 24 } });
    await advance(0);
    expect(sent).toEqual([]);
  });

  it('does not wait for an entire burst to refill before showing a small current screen', async () => {
    const pacer = createRemotePtyPacer({ screenSnapshot, now: () => t });
    pacer.outgoing(pty('x'.repeat(REMOTE_PTY_BURST)), send);
    await advance(REMOTE_PTY_FLUSH_MS);
    pacer.outgoing(pty('x'.repeat(REMOTE_PTY_BURST + 1)), send);
    await advance(REMOTE_PTY_FLUSH_MS);
    await advance(1);
    expect(sent.at(-1)).toEqual(pty('\x1bcSCREENLIVE'));
  });

  it('shares the byte budget across two flooding terminals', async () => {
    const screen = async () => ({ data: 's'.repeat(4 * 1024), live: '', size: { cols: 80, rows: 24 } });
    const pacer = createRemotePtyPacer({ screenSnapshot: screen, now: () => t });
    for (let i = 0; i < 600; i += 1) {
      pacer.outgoing(pty('x'.repeat(4 * 1024), 'p1'), send);
      pacer.outgoing(pty('x'.repeat(4 * 1024), 'p2'), send);
      await advance(REMOTE_PTY_FLUSH_MS);
    }
    const bytes = sent.reduce((sum, m) => sum + Buffer.byteLength(String((m as { data: string }).data), 'utf8'), 0);
    expect(bytes).toBeLessThanOrEqual(REMOTE_PTY_BURST + 60 * REMOTE_PTY_BYTES_PER_SEC);
    pacer.dispose();
  });

  it('stops after dispose', async () => {
    const pacer = createRemotePtyPacer({ screenSnapshot, now: () => t });
    pacer.outgoing(pty('a'), send);
    pacer.dispose();
    await advance(REMOTE_PTY_FLUSH_MS * 10);
    expect(sent).toEqual([]);
  });
});
