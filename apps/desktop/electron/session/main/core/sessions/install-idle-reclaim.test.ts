import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdleReclaimDeps } from './idle-reclaim';

const state = vi.hoisted(() => ({
  deps: null as IdleReclaimDeps | null,
  ptys: [] as Array<{ ptySessionId: string; metadata?: { providerId: string } }>,
  tmux: new Set<string>(),
  listTmux: vi.fn(),
  browserHost: false,
  browserSessions: [] as string[],
  rows: new Map<string, { projectId: string; archivedAt?: string }>(),
  closeBrowser: vi.fn(),
  browserBusy: vi.fn(() => false),
  browserWatched: vi.fn(() => false),
  shutdownBrowser: vi.fn(),
}));

vi.mock('./idle-reclaim', async (original) => {
  const actual = await original<typeof import('./idle-reclaim')>();
  return { ...actual, IdleReclaimer: class extends actual.IdleReclaimer {
    constructor(deps: IdleReclaimDeps) { super(deps); state.deps = deps; }
  } };
});
vi.mock('@main/core/acp/agent-status-bridge', () => ({ acpAgentStatusBridge: { current: () => new Map() } }));
vi.mock('@main/core/extensions/extension-bridge', () => ({ currentOrLastSession: () => null }));
vi.mock('@main/core/execution-context/local-execution-context', () => ({ LocalExecutionContext: class {} }));
vi.mock('@main/core/pty/pty-session-registry', () => ({ ptySessionRegistry: { listActiveSessions: () => state.ptys } }));
vi.mock('@main/core/pty/tmux-session-name', async (original) => ({
  ...await original<typeof import('@main/core/pty/tmux-session-name')>(),
  getConfiguredTmuxSocketLabel: () => 'test-owned-tmux',
  listTmuxSessionNames: () => state.listTmux(),
}));
vi.mock('@main/core/session-timeline/remote-pane', () => ({ sharedRemotePaneRoute: () => ({ watching: () => false }) }));
vi.mock('drizzle-orm', () => ({ eq: (_column: unknown, id: string) => id }));
vi.mock('@main/db/schema', () => ({ sessions: { id: 'id' } }));
vi.mock('@main/db/client', () => ({ db: {
  select: () => ({ from: () => ({ where: (id: string) => ({ get: () => state.rows.get(id) }) }) }),
} }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./session-orchestration', () => ({ stopExactSessionpageSession: vi.fn(async () => true) }));
vi.mock('./sessions-on-screen', () => ({ sessionOnScreen: () => false }));
vi.mock('./tui-resume-exactness', () => ({ tuiResumesExactly: () => true }));
vi.mock('./utils', () => ({ mapSessionRowToSession: (row: unknown) => row }));
vi.mock('../../../../browser-agent-mcp', () => ({ closeSessionBrowserTools: (...args: unknown[]) => state.closeBrowser(...args) }));
vi.mock('@main/core/browser/cloud/cloud-browser', () => ({
  isCloudBrowserHost: () => state.browserHost,
  cloudBrowser: () => ({ sessionIds: () => state.browserSessions, sessionInUse: state.browserBusy, shutdown: state.shutdownBrowser }),
  cloudAgentBrowserBridge: () => ({ closeSession: state.closeBrowser }),
}));
vi.mock('@main/core/browser/cloud/live-server', () => ({ cloudBrowserLive: () => ({ watching: state.browserWatched }) }));

import { makeTmuxSessionName } from '@main/core/pty/tmux-session-name';
import { installIdleReclaim } from './install-idle-reclaim';

describe('idle reclaim resource enumeration', () => {
  let dispose: (() => void) | undefined;
  beforeEach(() => {
    state.ptys = [];
    state.tmux = new Set();
    state.listTmux.mockReset().mockImplementation(async () => state.tmux);
    state.browserHost = false;
    state.browserSessions = [];
    state.rows.clear();
    state.closeBrowser.mockReset();
    state.shutdownBrowser.mockReset();
    state.browserBusy.mockReturnValue(false);
    state.browserWatched.mockReturnValue(false);
    dispose = installIdleReclaim({ agentStatus: { on: vi.fn() } });
  });
  afterEach(() => dispose?.());

  it('finds an agent surviving in tmux without a PTY attached to this host', async () => {
    state.tmux.add(makeTmuxSessionName('p:cold:cold'));
    state.tmux.add('unrelated-user-session');
    expect(await state.deps!.listLive()).toEqual([{ projectId: 'p', sessionId: 'cold', runtime: 'pty' }]);
  });

  it('deduplicates attached agents and protects detached user terminal shells', async () => {
    state.ptys = [{ ptySessionId: 'p:agent:agent', metadata: { providerId: 'codex' } }];
    state.tmux.add(makeTmuxSessionName('p:agent:agent'));
    state.tmux.add(makeTmuxSessionName('p:agent:terminal'));
    expect(await state.deps!.listLive()).toEqual([{ projectId: 'p', sessionId: 'agent', runtime: 'pty' }]);
    expect(state.deps!.sessionsWithLiveTerminals()).toEqual(new Set(['agent']));
  });

  it('includes pages whose owning agent process has already stopped', async () => {
    state.browserHost = true;
    state.browserSessions = ['finished'];
    state.rows.set('finished', { projectId: 'p' });
    expect(await state.deps!.listLive()).toEqual([{ projectId: 'p', sessionId: 'finished', runtime: 'browser' }]);
    state.browserBusy.mockReturnValue(true);
    expect(state.deps!.watchedRemotely('finished')).toBe(true);
    state.browserBusy.mockReturnValue(false);
    state.browserWatched.mockReturnValue(true);
    expect(state.deps!.watchedRemotely('finished')).toBe(true);
  });

  it('releases pages for deleted or archived owners instead of retaining an orphan', async () => {
    state.browserHost = true;
    state.browserSessions = ['deleted', 'archived'];
    state.rows.set('archived', { projectId: 'p', archivedAt: 'now' });
    expect(await state.deps!.listLive()).toEqual([]);
    expect(state.closeBrowser.mock.calls.map(([id]) => id)).toEqual(['deleted', 'archived']);
  });

  it('does not turn a failed tmux read into a false empty-process reading', async () => {
    state.listTmux.mockRejectedValue(new Error('tmux unreadable'));
    await expect(state.deps!.listLive()).rejects.toThrow('tmux unreadable');
  });

  it('releases an unowned browser through the same sweep, while retaining an active viewer or operation', async () => {
    state.browserHost = true;
    state.browserWatched.mockReturnValue(true);
    await state.deps!.listLive();
    expect(state.shutdownBrowser).not.toHaveBeenCalled();
    state.browserWatched.mockReturnValue(false);
    state.browserBusy.mockReturnValue(true);
    await state.deps!.listLive();
    expect(state.shutdownBrowser).not.toHaveBeenCalled();
    state.browserBusy.mockReturnValue(false);
    await state.deps!.listLive();
    expect(state.shutdownBrowser).toHaveBeenCalledOnce();
  });
});
