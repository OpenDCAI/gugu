import { afterEach, expect, it, vi } from 'vitest';
import { previewReloadQueue } from '@/components/preview/preview-reload';

afterEach(() => vi.useRealTimers());
it('coalesces a burst and ignores unchanged resyncs', async () => {
  vi.useFakeTimers();
  const check = vi.fn(async (paths?: string[]) => Boolean(paths?.includes('used.css')));
  const reload = vi.fn(); const error = vi.fn();
  const queue = previewReloadQueue(check, reload, error);
  queue.changed(['used.css']); queue.changed(['used.js']); queue.changed(['used.css']);
  await vi.advanceTimersByTimeAsync(210);
  expect(check).toHaveBeenCalledExactlyOnceWith(['used.css', 'used.js']);
  expect(reload).toHaveBeenCalledOnce();
  queue.changed(); await vi.advanceTimersByTimeAsync(210);
  expect(check).toHaveBeenLastCalledWith(undefined);
  expect(reload).toHaveBeenCalledOnce();
  expect(error).not.toHaveBeenCalled(); queue.dispose();
});
it('waits for in-flight changes, reloads once, and cancels after disposal', async () => {
  vi.useFakeTimers();
  let resolve!: (changed: boolean) => void;
  const check = vi.fn().mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done; })).mockResolvedValue(true);
  const reload = vi.fn(); const error = vi.fn();
  const queue = previewReloadQueue(check, reload, error);
  queue.changed(['used.css']); await vi.advanceTimersByTimeAsync(210);
  queue.changed(['used.js']); resolve(true); await vi.advanceTimersByTimeAsync(210);
  expect(reload).toHaveBeenCalledOnce();
  queue.changed(); queue.dispose(); await vi.advanceTimersByTimeAsync(210);
  expect(check).toHaveBeenCalledTimes(2);
});

it('ends a stuck transport check, accepts later changes, and ignores its late result', async () => {
  vi.useFakeTimers();
  let finish!: (changed: boolean) => void;
  const check = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; })).mockResolvedValue(true);
  const reload = vi.fn(); const error = vi.fn();
  const queue = previewReloadQueue(check, reload, error);
  try {
    queue.changed(['used.css']); await vi.advanceTimersByTimeAsync(210);
    await vi.advanceTimersByTimeAsync(90_001);
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]![0])).toContain('timed out');
    queue.changed(); await vi.advanceTimersByTimeAsync(210);
    expect(check).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledOnce();
    finish(true); await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalledOnce();
  } finally { queue.dispose(); }
});

it('cancels the deadline on disposal without reporting an error or a reload', async () => {
  vi.useFakeTimers();
  const error = vi.fn(); const reload = vi.fn();
  const queue = previewReloadQueue(async () => new Promise<boolean>(() => {}), reload, error);
  queue.changed(); await vi.advanceTimersByTimeAsync(210); queue.dispose();
  await vi.advanceTimersByTimeAsync(90_001);
  expect(error).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
