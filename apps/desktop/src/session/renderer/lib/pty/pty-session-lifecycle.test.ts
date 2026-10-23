import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<void>>(),
  views: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
}));
vi.mock('@renderer/lib/ipc', () => ({ events: { on: () => () => {} } }));
vi.mock('@renderer/lib/pty/pty', () => ({
  loadXterm: async () => {},
  FrontendPty: class {
    dispose = vi.fn();
    constructor() { mocks.views.push(this); }
    connect() { return mocks.connect(); }
  },
}));

import { PtySession } from './pty-session';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const sessions: PtySession[] = [];
function session(prepare?: () => Promise<void>) {
  const value = new PtySession('terminal-1', prepare);
  sessions.push(value);
  return value;
}

describe('PtySession view lifecycle', () => {
  beforeEach(() => {
    mocks.views.length = 0;
    mocks.connect.mockReset().mockResolvedValue();
  });
  afterEach(() => { for (const value of sessions.splice(0)) value.destroy(); });

  it('disposes the closed view and builds a new view for the same terminal when reopened', async () => {
    const value = session();
    await value.connect();
    const first = value.pty;
    value.dispose();
    expect(value.pty).toBeNull();
    expect(value.status).toBe('disconnected');
    expect(mocks.views[0]!.dispose).toHaveBeenCalledOnce();
    await value.connect();
    expect(value.pty).not.toBe(first);
    expect(value.status).toBe('ready');
    expect(mocks.views).toHaveLength(2);
  });

  it('reopens after a cancelled preparation finishes instead of staying disconnected', async () => {
    const pending = deferred();
    const prepare = vi.fn<() => Promise<void>>().mockResolvedValue().mockReturnValueOnce(pending.promise);
    const value = session(prepare);
    const first = value.connect();
    value.dispose();
    const reopened = value.connect();
    pending.resolve();
    await Promise.all([first, reopened]);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(mocks.views).toHaveLength(1);
    expect(value.pty).toBe(mocks.views[0]);
    expect(value.status).toBe('ready');
  });

  it('waits for the cancelled subscription before connecting the replacement view', async () => {
    const pending = deferred();
    mocks.connect.mockReturnValueOnce(pending.promise);
    const value = session();
    const first = value.connect();
    await vi.waitFor(() => expect(mocks.views).toHaveLength(1));
    value.dispose();
    const reopened = value.connect();
    expect(mocks.views).toHaveLength(1);
    pending.resolve();
    await Promise.all([first, reopened]);
    expect(mocks.views).toHaveLength(2);
    expect(mocks.views[0]!.dispose).toHaveBeenCalledOnce();
    expect(value.pty).toBe(mocks.views[1]);
    expect(value.status).toBe('ready');
  });
});
