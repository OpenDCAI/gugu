import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@gugu/session-shared/logger';
import type { LiveClientHandle } from '../../api/client';
import { deferred } from '../../testing';
import type { LiveSnapshot, LiveUpdate } from '../protocol';
import { ReplicaState } from './state';

type Value = { count: number };
const snapshot = (count: number): LiveSnapshot<Value> => ({ generation: 1, sequence: count, timestamp: 0, data: { count } });

function pendingInitialState() {
  const first = deferred<LiveSnapshot<Value>>();
  let latest = 0;
  let reads = 0;
  let receive: (update: LiveUpdate) => void = () => undefined;
  const read = vi.fn(() => ++reads === 1 ? first.promise : Promise.resolve(snapshot(latest)));
  const warn = vi.fn();
  const resync = vi.fn();
  const handle = {
    topic: 'sessions.list',
    snapshot: read,
    attach: async (listener: (update: LiveUpdate) => void) => { receive = listener; return () => undefined; },
  } as unknown as LiveClientHandle<Value>;
  const state = new ReplicaState(handle, { logger: { warn } as unknown as Logger, instrumentation: { resync } });
  const burst = (count: number) => {
    for (let i = 0; i < count; i += 1) {
      const baseSequence = latest++;
      receive({ generation: 1, baseSequence, sequence: latest, timestamp: 0, delta: [{ op: 'replace', path: ['count'], value: latest }] });
    }
  };
  return { state, first, read, warn, resync, burst, missOne: () => { latest += 1; } };
}

describe('initial replica snapshot and concurrent updates', () => {
  it('does not repeatedly fetch full lists when updates keep arriving during gap recovery', async () => {
    let receive: (update: LiveUpdate) => void = () => undefined;
    let latest = 0;
    const read = vi.fn(async (): Promise<LiveSnapshot<Value>> => {
      const captured = snapshot(latest);
      if (read.mock.calls.length > 1 && read.mock.calls.length < 6) {
        await Promise.resolve();
        for (let i = 0; i < 5; i++) {
          const baseSequence = latest++;
          receive({ generation: 1, baseSequence, sequence: latest, timestamp: 0,
            delta: [{ op: 'replace', path: ['count'], value: latest }] });
        }
      }
      return captured;
    });
    const handle = {
      topic: 'sessions.list', snapshot: read,
      attach: async (listener: (update: LiveUpdate) => void) => { receive = listener; return () => undefined; },
    } as unknown as LiveClientHandle<Value>;
    const state = new ReplicaState(handle, { logger: { warn: vi.fn(), info: vi.fn() } as unknown as Logger });
    try {
      await state.ready;
      latest = 2; // One update was genuinely missed; recovery is required.
      receive({ generation: 1, baseSequence: 1, sequence: 2, timestamp: 0,
        delta: [{ op: 'replace', path: ['count'], value: 2 }] });
      await vi.waitFor(() => expect(state.current()).toEqual({ count: latest }));
      expect(read).toHaveBeenCalledTimes(2);
      expect(state.cursor?.sequence).toBe(7);
    } finally { await state.dispose(); }
  });

  it('continues applying updates when a later snapshot request fails', async () => {
    let receive: (update: LiveUpdate) => void = () => undefined;
    const later = deferred<LiveSnapshot<Value>>();
    const read = vi.fn().mockResolvedValueOnce(snapshot(0)).mockImplementation(() => later.promise);
    const handle = {
      topic: 'sessions.list', snapshot: read,
      attach: async (listener: (update: LiveUpdate) => void) => { receive = listener; return () => undefined; },
    } as unknown as LiveClientHandle<Value>;
    const state = new ReplicaState(handle);
    try {
      await state.ready;
      const refresh = state.refresh();
      receive({ generation: 1, baseSequence: 0, sequence: 1, timestamp: 0,
        delta: [{ op: 'replace', path: ['count'], value: 1 }] });
      const rejected = expect(refresh).rejects.toThrow('snapshot unavailable');
      later.reject(new Error('snapshot unavailable'));
      await rejected;
      receive({ generation: 1, baseSequence: 1, sequence: 2, timestamp: 0,
        delta: [{ op: 'replace', path: ['count'], value: 2 }] });
      expect(state.current()).toEqual({ count: 2 });
      expect(read).toHaveBeenCalledTimes(2);
    } finally { await state.dispose(); }
  });

  it('keeps updates received while a later refresh snapshot is in flight', async () => {
    let receive: (update: LiveUpdate) => void = () => undefined;
    const later = deferred<LiveSnapshot<Value>>();
    const read = vi.fn().mockResolvedValueOnce(snapshot(0)).mockImplementation(() => later.promise);
    const handle = {
      topic: 'sessions.list', snapshot: read,
      attach: async (listener: (update: LiveUpdate) => void) => { receive = listener; return () => undefined; },
    } as unknown as LiveClientHandle<Value>;
    const state = new ReplicaState(handle);
    try {
      await state.ready;
      const refresh = state.refresh();
      for (let i = 0; i < 20; i++) receive({ generation: 1, baseSequence: i, sequence: i + 1, timestamp: 0,
        delta: [{ op: 'replace', path: ['count'], value: i + 1 }] });
      later.resolve(snapshot(0));
      await refresh;
      expect(state.current()).toEqual({ count: 20 });
      expect(state.cursor?.sequence).toBe(20);
      expect(read).toHaveBeenCalledTimes(2);
    } finally { await state.dispose(); }
  });

  it('uses the pending snapshot once when it already covers a pre-seed burst, without per-update resync warnings', async () => {
    const f = pendingInitialState();
    try {
      f.burst(20);
      f.first.resolve(snapshot(20));
      await f.state.ready;
      expect(f.state.current()).toEqual({ count: 20 });
      expect(f.read).toHaveBeenCalledTimes(1);
      expect(f.warn).not.toHaveBeenCalled();
      expect(f.resync).not.toHaveBeenCalled();
    } finally { await f.state.dispose(); }
  });

  it('replays an uncovered contiguous burst without extra snapshots, and still applies later live updates', async () => {
    const f = pendingInitialState();
    try {
      f.burst(20);
      f.first.resolve(snapshot(0));
      await f.state.ready;
      expect(f.state.current()).toEqual({ count: 20 });
      expect(f.read).toHaveBeenCalledTimes(1);
      f.burst(1);
      expect(f.state.current()).toEqual({ count: 21 });
      expect(f.read).toHaveBeenCalledTimes(1);
    } finally { await f.state.dispose(); }
  });

  it('still recovers a genuine missing initial update before ready resolves', async () => {
    const f = pendingInitialState();
    try {
      f.missOne();
      f.burst(1);
      f.first.resolve(snapshot(0));
      await f.state.ready;
      expect(f.state.current()).toEqual({ count: 2 });
      expect(f.read).toHaveBeenCalledTimes(2);
      expect(f.warn).toHaveBeenCalledTimes(1);
      expect(f.resync).toHaveBeenCalledTimes(1);
    } finally { await f.state.dispose(); }
  });
});
