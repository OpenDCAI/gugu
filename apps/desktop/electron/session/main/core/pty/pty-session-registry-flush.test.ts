import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { events } from '@main/lib/events';
import type { Pty, PtyExitInfo } from './pty';
import { PtySessionRegistry } from './pty-session-registry';

vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn(), on: vi.fn(() => () => {}) } }));

function fakePty() {
  let onData: (d: string) => void = () => {};
  const pty: Pty & { out(d: string): void } = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (h) => (onData = h),
    onExit: (_h: (i: PtyExitInfo) => void) => {},
    out: (d) => onData(d),
  };
  return pty;
}

const batches = () =>
  vi
    .mocked(events.emit)
    .mock.calls.filter(([, data, id]) => id === 'p:t:c' && typeof data === 'string')
    .map(([, data]) => data as string);

describe('PtySessionRegistry output batching (@@@leading-edge-flush)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(events.emit).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('空闲后的第一块当场发出,同一拍里后到的攒成一批,安静一拍之后又是当场发', () => {
    const registry = new PtySessionRegistry();
    const pty = fakePty();
    registry.register('p:t:c', pty, { size: { cols: 40, rows: 5 } });

    pty.out('a');
    expect(batches()).toEqual(['a']);

    pty.out('b');
    pty.out('c');
    expect(batches()).toEqual(['a']);
    vi.advanceTimersByTime(16);
    expect(batches()).toEqual(['a', 'bc']);

    // 这一拍什么也没到:窗口关上,不发空批。
    vi.advanceTimersByTime(16);
    expect(batches()).toEqual(['a', 'bc']);

    pty.out('d');
    expect(batches()).toEqual(['a', 'bc', 'd']);
  });

  it('持续输出时一拍一批,❌ 每块一条', () => {
    const registry = new PtySessionRegistry();
    const pty = fakePty();
    registry.register('p:t:c', pty, { size: { cols: 40, rows: 5 } });

    for (let i = 0; i < 64; i++) {
      pty.out('x');
      vi.advanceTimersByTime(1);
    }
    vi.advanceTimersByTime(32);
    expect(batches().join('')).toBe('x'.repeat(64));
    // 64ms 的连续输出:第一块 + 每 16ms 一批。
    expect(batches().length).toBe(5);
  });

  // @@@frame-open — a frame still being drawn is not sent on arrival; the chunk that finishes it sends it.
  describe('a frame still being drawn', () => {
    const setup = () => {
      const registry = new PtySessionRegistry();
      const pty = fakePty();
      registry.register('p:t:c', pty, { size: { cols: 40, rows: 5 } });
      return pty;
    };

    it('an open synchronized-output block waits for its end, then goes out as one batch', () => {
      const pty = setup();
      pty.out('\x1b[?2026h\x1b[1;1Hspinner');
      expect(batches()).toEqual([]);
      pty.out('\x1b[5;3H\x1b[?2026l');
      expect(batches()).toEqual(['\x1b[?2026h\x1b[1;1Hspinner\x1b[5;3H\x1b[?2026l']);
    });

    it('a synchronized-output block that closes in the same chunk goes out at once', () => {
      const pty = setup();
      pty.out('\x1b[?2026h\x1b[1;1Hspinner\x1b[5;3H\x1b[?2026l');
      expect(batches()).toEqual(['\x1b[?2026h\x1b[1;1Hspinner\x1b[5;3H\x1b[?2026l']);
    });

    it('a cursor hidden in this batch waits for it to be shown again (psmux sends the two halves ~15ms apart)', () => {
      const pty = setup();
      pty.out('\x1b[?25l\x1b[4;1Hstatus 7');
      vi.advanceTimersByTime(15);
      expect(batches()).toEqual([]);
      pty.out('\x1b[5;3H\x1b[?25h');
      expect(batches()).toEqual(['\x1b[?25l\x1b[4;1Hstatus 7\x1b[5;3H\x1b[?25h']);
    });

    it('hiding and showing the cursor in the same chunk goes out at once', () => {
      const pty = setup();
      pty.out('\x1b[?25la\x1b[?25h');
      expect(batches()).toEqual(['\x1b[?25la\x1b[?25h']);
    });

    it('an unfinished frame still goes out at the end of the frame window: the wait is capped at 16ms', () => {
      const pty = setup();
      pty.out('\x1b[?2026hhalf');
      vi.advanceTimersByTime(16);
      expect(batches()).toEqual(['\x1b[?2026hhalf']);
    });

    it('a full-screen TUI that keeps the cursor hidden is not held back on every chunk', () => {
      const pty = setup();
      pty.out('\x1b[?25l\x1b[2J');
      vi.advanceTimersByTime(32); // the batch that hid it waits for the window, once
      expect(batches()).toEqual(['\x1b[?25l\x1b[2J']);
      pty.out('x');
      expect(batches()).toEqual(['\x1b[?25l\x1b[2J', 'x']);
    });

    it('a sequence cut between two reads is read as one: …\\x1b[?25 | h closes the frame', () => {
      const pty = setup();
      pty.out('\x1b[?25lstatus\x1b[?25');
      expect(batches()).toEqual([]);
      pty.out('h');
      expect(batches()).toEqual(['\x1b[?25lstatus\x1b[?25h']);
    });

    it('a sequence cut between two reads is read as one: …\\x1b[?202 | 6h opens a block', () => {
      const pty = setup();
      pty.out('done\x1b[?202');
      expect(batches()).toEqual(['done\x1b[?202']);
      vi.advanceTimersByTime(32);
      pty.out('6hhalf');
      expect(batches()).toEqual(['done\x1b[?202']);
      pty.out('\x1b[?2026l');
      expect(batches()).toEqual(['done\x1b[?202', '6hhalf\x1b[?2026l']);
    });
  });
});
