import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers: Array<(event: { id: string }) => void> = [];
const resize = vi.fn();

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: (_channel: unknown, handler: (event: { id: string }) => void) => {
      handlers.push(handler);
      return () => undefined;
    },
  },
  rpc: { pty: { resize: (...args: unknown[]) => resize(...args) } },
}));
vi.mock('@renderer/lib/pty/pty', () => ({ FrontendPty: class {}, loadXterm: async () => {} }));

const { PtySession } = await import('./pty-session');

function readySession(options: { clearOnBackendStart?: boolean } = {}) {
  const session = new PtySession('conv-1', undefined, undefined, undefined, options);
  const clear = vi.fn();
  session.pty = { terminal: { cols: 180, rows: 48 }, clear } as never;
  session.status = 'ready';
  return { session, clear };
}

describe('PtySession backend restart', () => {
  beforeEach(() => {
    handlers.length = 0;
    resize.mockClear();
  });

  it('re-sends the live grid size to a replacement process on the same pty id', () => {
    const { clear } = readySession({ clearOnBackendStart: true });
    handlers[0]!({ id: 'conv-1' }); // first backend start: the one connect() attached to
    expect(resize).not.toHaveBeenCalled();
    handlers[0]!({ id: 'conv-1' }); // restart (model switch / manual reload)
    expect(clear).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith('conv-1', 180, 48);
  });

  it('ignores starts of other pty ids', () => {
    readySession();
    handlers[0]!({ id: 'conv-1' });
    handlers[0]!({ id: 'conv-2' });
    expect(resize).not.toHaveBeenCalled();
  });
});
