import { describe, expect, it, vi } from 'vitest';
import type { Pty } from './pty';
import { PtySessionRegistry } from './pty-session-registry';

vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn(), on: vi.fn(() => () => {}) } }));

function fakePty(): Pty {
  return { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: () => {}, onExit: () => {} };
}

// The TUI repaints its whole screen on every resize it receives, so the one place every resize passes
// through (this desktop's panes, an attached second desktop, a restart re-send) drops a size the PTY has.
describe('PtySessionRegistry.resize', () => {
  it('passes a changed size to the PTY and drops a repeat of the size it already has', () => {
    const registry = new PtySessionRegistry();
    const pty = fakePty();
    registry.register('p:t:c', pty, { size: { cols: 80, rows: 24 } });
    registry.resize('p:t:c', 120, 40);
    registry.resize('p:t:c', 120, 40);
    registry.resize('p:t:c', 79, 40);
    registry.resize('p:t:c', 79, 40);
    registry.resize('p:t:c', 120, 40);
    expect(vi.mocked(pty.resize).mock.calls).toEqual([[120, 40], [79, 40], [120, 40]]);
  });

  it('a size asked for before the PTY existed is applied when it registers, and not again after', () => {
    const registry = new PtySessionRegistry();
    expect(registry.resize('p:t:c', 100, 30)).toBe(false);
    const pty = fakePty();
    registry.register('p:t:c', pty, { size: { cols: 80, rows: 24 } });
    registry.resize('p:t:c', 100, 30);
    expect(vi.mocked(pty.resize).mock.calls).toEqual([[100, 30]]);
  });

  it('a replacement process on the same id gets the size again (restart re-send)', () => {
    const registry = new PtySessionRegistry();
    const first = fakePty();
    registry.register('p:t:c', first, { size: { cols: 80, rows: 24 } });
    registry.resize('p:t:c', 120, 40);
    const second = fakePty();
    registry.register('p:t:c', second, { size: { cols: 80, rows: 24 } });
    expect(vi.mocked(second.resize).mock.calls).toEqual([[120, 40]]);
  });
});
