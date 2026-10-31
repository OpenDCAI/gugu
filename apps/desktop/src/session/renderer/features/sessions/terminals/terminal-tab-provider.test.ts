import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceTerminals } from '../workspace-backend/workspace-terminal-backend';

const mocks = vi.hoisted(() => ({ manager: null as WorkspaceTerminals | null, dispose: vi.fn() }));
vi.mock('../workspace-backend/workspace-backend', () => ({
  workspaceBackend: () => ({ terminal: { terminals: () => mocks.manager } }),
}));
vi.mock('@renderer/lib/ipc', () => ({ events: { on: () => () => {} } }));
vi.mock('@renderer/lib/pty/pty', () => ({
  loadXterm: async () => {},
  FrontendPty: class {
    connect = async () => {};
    dispose = mocks.dispose;
  },
}));

import { PtySession } from '@renderer/lib/pty/pty-session';
import { terminalTabProvider } from './terminal-tab-provider';

const sessions: PtySession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.destroy();
  vi.clearAllMocks();
});

const entry = { kind: 'terminal', tabId: 'tab-1', isPreview: false, state: { terminalId: 'terminal-1' } } as const;
const ctx = { viewId: 'task-1', projectId: 'project-1', workspaceId: 'workspace-1', modelRootPath: 'workspace:workspace-1' };

describe('terminal tab view lifetime', () => {
  it('releases a closed view while keeping the terminal record and session available to reopen', async () => {
    const session = new PtySession('terminal-1');
    sessions.push(session);
    const manager = {
      isLoaded: true,
      terminals: new Map([['terminal-1', { data: { name: 'Terminal 1' } }]]),
      sessions: new Map([['terminal-1', session]]),
      createDefaultTerminal: vi.fn(),
    };
    mocks.manager = manager;
    await session.connect();
    const first = session.pty;
    const resource = terminalTabProvider.initialize(entry, {} as never, ctx);
    terminalTabProvider.dispose(entry, resource, ctx);
    terminalTabProvider.dispose(entry, resource, ctx);
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(session.pty).toBeNull();
    expect(manager.terminals.has('terminal-1')).toBe(true);
    expect(manager.sessions.get('terminal-1')).toBe(session);

    const reopened = terminalTabProvider.initialize(entry, {} as never, ctx);
    reopened.onActivateIntent?.();
    await vi.waitFor(() => expect(session.status).toBe('ready'));
    expect(session.pty).not.toBe(first);
    terminalTabProvider.dispose(entry, reopened, ctx);
  });

  it('still delegates remote terminal shutdown to its backend when the tab closes', async () => {
    const session = new PtySession('terminal-1');
    sessions.push(session);
    const closeTerminal = vi.fn();
    mocks.manager = {
      isLoaded: true,
      terminals: new Map([['terminal-1', { data: { name: 'Terminal 1' } }]]),
      sessions: new Map([['terminal-1', session]]),
      createDefaultTerminal: vi.fn(),
      closeTerminal,
    };
    await session.connect();
    const resource = terminalTabProvider.initialize(entry, {} as never, ctx);
    terminalTabProvider.dispose(entry, resource, ctx);
    expect(session.pty).toBeNull();
    expect(closeTerminal).toHaveBeenCalledExactlyOnceWith('terminal-1');
  });
});
