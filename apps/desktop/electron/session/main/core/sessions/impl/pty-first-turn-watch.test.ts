import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstTurnNotTakenMessage, redactScreenLine, watchFirstTurnTaken } from './pty-first-turn-watch';

// owner 10-28 (Linux 2, e4e174ec): a pty task with a first message never took it; nothing said what its terminal showed.
describe('a pty harness that does not take its first message', () => {
  let heard: (() => void) | null;
  let alive: boolean;
  let reports: Array<{ lines: string[]; alive: boolean }>;
  const start = () =>
    watchFirstTurnTaken({
      onHook: (cb) => {
        heard = cb;
        return () => { heard = null; };
      },
      alive: () => alive,
      screenText: async () => ['Welcome to Claude Code', 'Do you trust the files in this folder?', 'token: ' + 'a'.repeat(40)],
      report: (failure) => reports.push(failure),
      withinMs: 20_000,
    });
  beforeEach(() => {
    vi.useFakeTimers();
    heard = null;
    alive = true;
    reports = [];
  });
  afterEach(() => vi.useRealTimers());

  it('no hook within the window while the pty lives: reports the last screen lines, secrets masked', async () => {
    start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reports).toEqual([{ lines: ['Welcome to Claude Code', 'Do you trust the files in this folder?', 'token: [redacted]'], alive: true }]);
  });

  it('any hook from this spawn before the window: nothing', async () => {
    start();
    await vi.advanceTimersByTimeAsync(5_000);
    heard?.();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reports).toEqual([]);
  });

  it('the pty already gone (its exit path reports): nothing; stopped early: nothing', async () => {
    alive = false;
    start();
    await vi.advanceTimersByTimeAsync(20_000);
    alive = true;
    const stop = start();
    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reports).toEqual([]);
  });

  it('masks bearer tokens and key-shaped strings, keeps ordinary text', () => {
    expect(redactScreenLine('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [redacted]');
    expect(redactScreenLine('key sk-ant-api03-ABCDEFGH12345')).toBe('key [redacted]');
    expect(redactScreenLine('❯ reply with just OK')).toBe('❯ reply with just OK');
  });

  it('the message names the harness, the window, and carries the lines', () => {
    expect(firstTurnNotTakenMessage('Claude', [' a', '', 'b ', 'c'])).toBe('Claude in the terminal did not take the first message within 20 s. Its screen ends with: "b / c"\n a\n\nb \nc');
    expect(firstTurnNotTakenMessage('Claude', [])).toBe('Claude in the terminal did not take the first message within 20 s. Its screen was empty.');
  });
});
