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
