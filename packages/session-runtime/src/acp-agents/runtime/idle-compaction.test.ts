import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdleCompaction, ASSISTANT_IDLE_COMPACT_MS, ASSISTANT_IDLE_COMPACT_TOKENS } from './idle-compaction';

afterEach(() => vi.useRealTimers());

describe('assistant idle compaction scheduler', () => {
  it('waits for sustained idle, rechecks admission at the deadline, and attempts once per real-turn revision', async () => {
    vi.useFakeTimers();
    let state = { idle: true, contextTokens: ASSISTANT_IDLE_COMPACT_TOKENS, revision: 1 };
    const compact = vi.fn(async () => undefined);
    const scheduler = new IdleCompaction(() => state, compact);
    scheduler.update();
    await vi.advanceTimersByTimeAsync(ASSISTANT_IDLE_COMPACT_MS - 1);
    expect(compact).not.toHaveBeenCalled();
    state = { ...state, idle: false };
    await vi.advanceTimersByTimeAsync(1);
    expect(compact).not.toHaveBeenCalled();
    state = { ...state, idle: true, revision: 2 };
    scheduler.update();
    await vi.advanceTimersByTimeAsync(ASSISTANT_IDLE_COMPACT_MS);
    expect(compact).toHaveBeenCalledOnce();
    scheduler.update();
    await vi.advanceTimersByTimeAsync(ASSISTANT_IDLE_COMPACT_MS * 3);
    expect(compact).toHaveBeenCalledOnce();
    scheduler.close();
  });

  it('does not compact short/unknown contexts or run after disposal', async () => {
    vi.useFakeTimers();
    let state = { idle: true, contextTokens: null as number | null, revision: 1 };
    const compact = vi.fn(async () => undefined);
    const scheduler = new IdleCompaction(() => state, compact);
    scheduler.update();
    await vi.advanceTimersByTimeAsync(ASSISTANT_IDLE_COMPACT_MS);
    state = { ...state, contextTokens: ASSISTANT_IDLE_COMPACT_TOKENS - 1 };
    scheduler.update();
    await vi.advanceTimersByTimeAsync(ASSISTANT_IDLE_COMPACT_MS);
    state = { ...state, contextTokens: ASSISTANT_IDLE_COMPACT_TOKENS };
    scheduler.update();
    scheduler.close();
    await vi.advanceTimersByTimeAsync(ASSISTANT_IDLE_COMPACT_MS);
    expect(compact).not.toHaveBeenCalled();
  });

  it('does not retry a failed maintenance operation in a timer loop', async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const scheduler = new IdleCompaction(() => ({ idle: true, contextTokens: 150_000, revision: 1 }),
      async () => { throw new Error('native rejected'); }, failed);
    scheduler.update();
    await vi.advanceTimersByTimeAsync(ASSISTANT_IDLE_COMPACT_MS);
    scheduler.update();
    await vi.advanceTimersByTimeAsync(ASSISTANT_IDLE_COMPACT_MS * 3);
    expect(failed).toHaveBeenCalledOnce();
    scheduler.close();
  });

  it('discards an overdue timer after process suspension instead of compacting before wake delivery', async () => {
    vi.useFakeTimers();
    const compact = vi.fn(async () => undefined);
    const scheduler = new IdleCompaction(() => ({ idle: true, contextTokens: 150_000, revision: 1 }), compact);
    scheduler.update();
    vi.setSystemTime(Date.now() + 15 * 60_000);
    await vi.advanceTimersByTimeAsync(ASSISTANT_IDLE_COMPACT_MS);
    expect(compact).not.toHaveBeenCalled();
    scheduler.close();
  });
});
